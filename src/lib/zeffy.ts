import { prisma } from "@/lib/prisma";
import { recalcFundraiserTotal } from "@/lib/fundraiser-total";

const ZEFFY_API_BASE = "https://api.zeffy.com/api/v1";

/**
 * Check the `token` query param on an incoming Zeffy webhook against the
 * configured secret. Fails closed when no secret is configured.
 *
 * Both sides are trimmed: until September 2026 the stored secret carried a
 * trailing newline, so a strict comparison rejected every real webhook and no
 * Zeffy donation was ever recorded. Whitespace is never meaningful in the token.
 */
export function isValidZeffyWebhookToken(
  token: string | null | undefined,
  secret: string | null | undefined
): boolean {
  const expected = secret?.trim();
  if (!expected) return false;
  return token?.trim() === expected;
}

/**
 * Store a Zeffy API key for an office.
 */
export async function storeZeffyApiKey(
  officeId: string,
  apiKey: string
): Promise<void> {
  await prisma.integrationToken.upsert({
    where: {
      officeId_provider: { officeId, provider: "zeffy" },
    },
    create: {
      officeId,
      provider: "zeffy",
      accessToken: apiKey,
      refreshToken: "",
      expiresAt: new Date("2099-12-31"),
    },
    update: {
      accessToken: apiKey,
    },
  });
}

/**
 * Check if Zeffy is connected for an office.
 */
export async function isZeffyConnected(officeId: string): Promise<boolean> {
  const token = await prisma.integrationToken.findUnique({
    where: {
      officeId_provider: { officeId, provider: "zeffy" },
    },
  });
  return !!token;
}

/**
 * Disconnect Zeffy by deleting the stored API key.
 */
export async function disconnectZeffy(officeId: string): Promise<void> {
  await prisma.integrationToken.deleteMany({
    where: { officeId, provider: "zeffy" },
  });
}

/**
 * Get the stored Zeffy API key for an office.
 */
export async function getZeffyApiKey(officeId: string): Promise<string> {
  const token = await prisma.integrationToken.findUnique({
    where: {
      officeId_provider: { officeId, provider: "zeffy" },
    },
  });
  if (!token) throw new Error("Zeffy not connected");
  return token.accessToken;
}

/**
 * Make an authenticated request to the Zeffy API.
 */
async function zeffyFetch(
  apiKey: string,
  endpoint: string,
  params?: Record<string, string>
): Promise<Response> {
  const url = new URL(`${ZEFFY_API_BASE}${endpoint}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zeffy API error (${res.status}): ${text}`);
  }

  return res;
}

/**
 * Validate a Zeffy API key by making a test request.
 */
export async function validateZeffyApiKey(apiKey: string): Promise<boolean> {
  try {
    await zeffyFetch(apiKey, "/payments", { limit: "1" });
    return true;
  } catch {
    return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface ZeffyPaginatedResponse<T = any> {
  data: T[];
  has_more: boolean;
  next_cursor?: string;
}

/**
 * Fetch payments from Zeffy API with cursor-based pagination.
 */
export async function fetchZeffyPayments(
  apiKey: string,
  cursor?: string
): Promise<ZeffyPaginatedResponse> {
  const params: Record<string, string> = {};
  if (cursor) params.cursor = cursor;
  const res = await zeffyFetch(apiKey, "/payments", params);
  return res.json();
}

/**
 * Fetch contacts from Zeffy API with cursor-based pagination.
 */
export async function fetchZeffyContacts(
  apiKey: string,
  cursor?: string
): Promise<ZeffyPaginatedResponse> {
  const params: Record<string, string> = {};
  if (cursor) params.cursor = cursor;
  const res = await zeffyFetch(apiKey, "/contacts", params);
  return res.json();
}

/**
 * Fetch campaigns from Zeffy API with cursor-based pagination.
 */
export async function fetchZeffyCampaigns(
  apiKey: string,
  cursor?: string
): Promise<ZeffyPaginatedResponse> {
  const params: Record<string, string> = {};
  if (cursor) params.cursor = cursor;
  const res = await zeffyFetch(apiKey, "/campaigns", params);
  return res.json();
}

/**
 * Find or create a fundraiser for a Zeffy campaign.
 */
async function findOrCreateFundraiserForCampaign(
  officeId: string,
  campaign: { id: string; title: string; goal_amount?: number }
): Promise<{ id: string; eventId: string | null }> {
  // Check if fundraiser already exists for this campaign
  const existing = await prisma.fundraiser.findUnique({
    where: { zeffyCampaignId: campaign.id },
    select: { id: true, eventId: true },
  });
  if (existing) return existing;

  // Create a slug from the campaign name
  const baseSlug = campaign.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const slug = `zeffy-${baseSlug}-${Date.now()}`;

  const fundraiser = await prisma.fundraiser.create({
    data: {
      title: campaign.title,
      goalAmount: campaign.goal_amount ? Math.round(campaign.goal_amount * 100) : 0,
      slug,
      zeffyCampaignId: campaign.id,
      officeId,
      isActive: true,
    },
    select: { id: true, eventId: true },
  });

  return fundraiser;
}

async function addEventInviteForZeffyDonor(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  eventId: string,
  peopleId: string | null,
  donorName: string | null,
  donorEmail: string | null
): Promise<void> {
  if (peopleId) {
    const alreadyInvited = await tx.eventInvite.findUnique({
      where: { eventId_peopleId: { eventId, peopleId } },
    });
    if (!alreadyInvited) {
      await tx.eventInvite.create({
        data: { eventId, peopleId, rsvpStatus: "YES" },
      });
    }
  } else if (donorName || donorEmail) {
    const alreadyGuest = donorEmail
      ? await tx.eventInvite.findFirst({ where: { eventId, guestEmail: donorEmail, isGuest: true } })
      : null;
    if (!alreadyGuest) {
      await tx.eventInvite.create({
        data: { eventId, isGuest: true, guestName: donorName, guestEmail: donorEmail, rsvpStatus: "YES" },
      });
    }
  }
}

/**
 * Match a donor email to an existing People record in the office.
 */
async function matchPersonByEmail(
  officeId: string,
  email: string
): Promise<string | null> {
  const person = await prisma.people.findFirst({
    where: {
      officeId,
      OR: [
        { email1: { equals: email, mode: "insensitive" } },
        { email2: { equals: email, mode: "insensitive" } },
      ],
    },
    select: { id: true },
  });
  return person?.id ?? null;
}

export interface PendingDuplicate {
  zeffyContact: {
    firstName: string;
    lastName: string;
    email: string;
    phoneNumber: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  };
  existingPerson: {
    id: string;
    firstName: string;
    lastName: string;
    email1: string | null;
    email2: string | null;
  };
}

/**
 * Sync donations from Zeffy into the database.
 * Returns a summary of the sync results.
 */
export async function syncZeffyDonations(
  officeId: string
): Promise<{ synced: number; skipped: number; errors: number }> {
  const apiKey = await getZeffyApiKey(officeId);
  let cursor: string | undefined;
  let synced = 0;
  let skipped = 0;
  let errors = 0;

  // First, fetch all campaigns to map campaign IDs to fundraisers
  const campaignMap = new Map<string, { id: string; eventId: string | null }>();
  let campaignCursor: string | undefined;
  do {
    const campaignsPage = await fetchZeffyCampaigns(apiKey, campaignCursor);
    for (const campaign of campaignsPage.data) {
      const fundraiser = await findOrCreateFundraiserForCampaign(officeId, {
        id: campaign.id,
        title: campaign.title,
        goal_amount: campaign.goal_amount,
      });
      campaignMap.set(campaign.id, fundraiser);
    }
    campaignCursor = campaignsPage.has_more ? campaignsPage.next_cursor : undefined;
  } while (campaignCursor);

  // Fetch and process payments
  do {
    const page = await fetchZeffyPayments(apiKey, cursor);

    for (const payment of page.data) {
      try {
        const paymentId = payment.id as string;

        // Idempotency: skip if already imported
        const existing = await prisma.donation.findUnique({
          where: { zeffyPaymentId: paymentId },
        });
        if (existing) {
          skipped++;
          continue;
        }

        // Determine fundraiser
        let fundraiser = payment.campaign_id
          ? campaignMap.get(payment.campaign_id)
          : undefined;

        // If no campaign mapped, create a default "Zeffy Donations" fundraiser
        if (!fundraiser) {
          fundraiser = await findOrCreateFundraiserForCampaign(officeId, {
            id: "zeffy-general",
            title: "Zeffy Donations",
          });
        }

        const fundraiserId = fundraiser.id;
        const eventId = fundraiser.eventId;

        const donorEmail = payment.buyer?.email as string | undefined;
        const donorName = [payment.buyer?.first_name, payment.buyer?.last_name]
          .filter(Boolean)
          .join(" ") || null;
        const amount = Math.round((payment.amount ?? 0) * 100); // Convert to cents

        // Match donor to existing person
        let peopleId: string | null = null;
        if (donorEmail) {
          peopleId = await matchPersonByEmail(officeId, donorEmail);
        }

        await prisma.$transaction(async (tx) => {
          await tx.donation.create({
            data: {
              fundraiserId,
              amount,
              donorName,
              donorEmail: donorEmail ?? null,
              peopleId,
              paymentMethod: "zeffy",
              zeffyPaymentId: paymentId,
              approvalStatus: peopleId ? "AUTO_APPROVED" : "PENDING",
              donatedAt: payment.created
                ? new Date(payment.created * 1000)
                : new Date(),
            },
          });

          await recalcFundraiserTotal(tx, fundraiserId);

          if (eventId) {
            await addEventInviteForZeffyDonor(tx, eventId, peopleId, donorName, donorEmail ?? null);
          }
        });

        synced++;
      } catch (err) {
        console.error("Error syncing Zeffy payment:", err);
        errors++;
      }
    }

    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);

  return { synced, skipped, errors };
}

/**
 * Sync contacts from Zeffy into the database as People records.
 * Returns a summary of the sync results.
 */
export async function syncZeffyContacts(
  officeId: string
): Promise<{ created: number; skipped: number; errors: number; pendingDuplicates: PendingDuplicate[] }> {
  const apiKey = await getZeffyApiKey(officeId);
  let cursor: string | undefined;
  let created = 0;
  let skipped = 0;
  let errors = 0;
  const pendingDuplicates: PendingDuplicate[] = [];

  do {
    const page = await fetchZeffyContacts(apiKey, cursor);

    for (const contact of page.data) {
      try {
        const email = contact.email as string | undefined;
        const firstName = (contact.first_name as string) || "Unknown";
        const lastName = (contact.last_name as string) || "Unknown";

        if (email) {
          // Skip if person with this email already exists
          const existingById = await matchPersonByEmail(officeId, email);
          if (existingById) {
            skipped++;
            continue;
          }
        }

        // Check for a name match (potential duplicate)
        const nameMatch = await prisma.people.findFirst({
          where: {
            officeId,
            firstName: { equals: firstName, mode: "insensitive" },
            lastName: { equals: lastName, mode: "insensitive" },
          },
          select: { id: true, firstName: true, lastName: true, email1: true, email2: true },
        });

        if (nameMatch && email) {
          // Has email + name match → flag for user review instead of auto-creating
          pendingDuplicates.push({
            zeffyContact: {
              firstName,
              lastName,
              email,
              phoneNumber: (contact.phone_number as string) ?? null,
              address: (contact.address?.line1 as string) ?? null,
              city: (contact.address?.city as string) ?? null,
              state: (contact.address?.state as string) ?? null,
              zip: (contact.address?.postal_code as string) ?? null,
            },
            existingPerson: nameMatch,
          });
          continue;
        }

        if (!email) {
          skipped++;
          continue;
        }

        await prisma.people.create({
          data: {
            firstName,
            lastName,
            email1: email,
            address: (contact.address?.line1 as string) ?? null,
            city: (contact.address?.city as string) ?? null,
            state: (contact.address?.state as string) ?? null,
            zip: (contact.address?.postal_code as string) ?? null,
            phoneNumber: (contact.phone_number as string) ?? null,
            officeId,
          },
        });

        created++;
      } catch (err) {
        console.error("Error syncing Zeffy contact:", err);
        errors++;
      }
    }

    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);

  return { created, skipped, errors, pendingDuplicates };
}

/**
 * Process a single Zeffy webhook payment event.
 */
export async function processZeffyWebhookPayment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payment: any,
  officeId: string
): Promise<void> {
  const paymentId = payment.id as string;

  // Idempotency check
  const existing = await prisma.donation.findUnique({
    where: { zeffyPaymentId: paymentId },
  });
  if (existing) return;

  // Find or create fundraiser for the campaign
  let fundraiser: { id: string; eventId: string | null };
  if (payment.campaign_id && payment.campaign) {
    fundraiser = await findOrCreateFundraiserForCampaign(officeId, {
      id: payment.campaign_id,
      title: payment.campaign.title || payment.campaign.name || "Zeffy Campaign",
    });
  } else {
    fundraiser = await findOrCreateFundraiserForCampaign(officeId, {
      id: "zeffy-general",
      title: "Zeffy Donations",
    });
  }

  const { id: fundraiserId, eventId } = fundraiser;

  const donorEmail = payment.buyer?.email as string | undefined;
  const donorName = [payment.buyer?.first_name, payment.buyer?.last_name]
    .filter(Boolean)
    .join(" ") || null;
  const amount = Math.round((payment.amount ?? 0) * 100);

  let peopleId: string | null = null;
  if (donorEmail) {
    peopleId = await matchPersonByEmail(officeId, donorEmail);
  }

  await prisma.$transaction(async (tx) => {
    await tx.donation.create({
      data: {
        fundraiserId,
        amount,
        donorName,
        donorEmail: donorEmail ?? null,
        peopleId,
        paymentMethod: "zeffy",
        zeffyPaymentId: paymentId,
        approvalStatus: peopleId ? "AUTO_APPROVED" : "PENDING",
        donatedAt: payment.created ? new Date(payment.created * 1000) : new Date(),
      },
    });

    await recalcFundraiserTotal(tx, fundraiserId);

    if (eventId) {
      await addEventInviteForZeffyDonor(tx, eventId, peopleId, donorName, donorEmail ?? null);
    }
  });
}

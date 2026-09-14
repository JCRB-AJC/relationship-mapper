import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateZeffyApiKey,
  syncZeffyDonations,
  syncZeffyContacts,
  processZeffyWebhookPayment,
  isValidZeffyWebhookToken,
} from "./zeffy";

// ─── Prisma mock ──────────────────────────────────────────────────────────────

vi.mock("@/lib/prisma", () => ({
  prisma: {
    integrationToken: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    fundraiser: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    donation: {
      findUnique: vi.fn(),
      create: vi.fn(),
      aggregate: vi.fn(),
    },
    people: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

import { prisma } from "@/lib/prisma";

type MockFn = ReturnType<typeof vi.fn>;
const mp = prisma as unknown as {
  integrationToken: { findUnique: MockFn };
  fundraiser: { findUnique: MockFn; create: MockFn; update: MockFn };
  donation: { findUnique: MockFn; create: MockFn; aggregate: MockFn };
  people: { findFirst: MockFn; create: MockFn };
  $transaction: MockFn;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const OFFICE_ID = "office-123";
const API_KEY = "zfy_test_key";

function mockApiKey() {
  mp.integrationToken.findUnique.mockResolvedValue({ accessToken: API_KEY });
}

function mockFetch(pages: object[]) {
  const fetchMock = vi.fn();
  pages.forEach((page) => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => page,
      text: async () => JSON.stringify(page),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mockTransaction() {
  mp.$transaction.mockImplementation(async (fn: (tx: typeof mp) => Promise<unknown>) => fn(mp));
}

beforeEach(() => {
  vi.clearAllMocks();
  // recalcFundraiserTotal aggregates donations then writes currentAmount; default
  // the aggregate so any donation-creating path has a safe total to write.
  mp.donation.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
});

// ─── validateZeffyApiKey ──────────────────────────────────────────────────────

describe("validateZeffyApiKey", () => {
  it("returns true when the API responds successfully", async () => {
    mockFetch([{ data: [], has_more: false }]);
    expect(await validateZeffyApiKey(API_KEY)).toBe(true);
  });

  it("returns false when the API returns a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, text: async () => "Unauthorized" }));
    expect(await validateZeffyApiKey(API_KEY)).toBe(false);
  });

  it("returns false when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    expect(await validateZeffyApiKey(API_KEY)).toBe(false);
  });
});

// ─── syncZeffyDonations ───────────────────────────────────────────────────────

describe("syncZeffyDonations", () => {
  it("syncs a new donation and auto-approves when donor email matches a known person", async () => {
    mockApiKey();
    mockFetch([
      // campaigns page
      { data: [{ id: "camp-1", title: "Annual Fund", goal_amount: 10000 }], has_more: false },
      // payments page
      {
        data: [{
          id: "pay-1",
          campaign_id: "camp-1",
          amount: 100,
          buyer: { email: "donor@example.com", first_name: "Jane", last_name: "Doe" },
          created: 1700000000,
        }],
        has_more: false,
      },
    ]);
    mp.fundraiser.findUnique.mockResolvedValue({ id: "fundraiser-1" }); // campaign already mapped
    mp.donation.findUnique.mockResolvedValue(null);                      // not a duplicate
    mp.people.findFirst.mockResolvedValue({ id: "person-1" });           // donor matched
    mockTransaction();

    const result = await syncZeffyDonations(OFFICE_ID);

    expect(result).toEqual({ synced: 1, skipped: 0, errors: 0 });
    expect(mp.donation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          approvalStatus: "AUTO_APPROVED",
          peopleId: "person-1",
          amount: 10000, // $100 → cents
          paymentMethod: "zeffy",
          zeffyPaymentId: "pay-1",
        }),
      })
    );
  });

  it("creates a PENDING donation when donor email does not match any person", async () => {
    mockApiKey();
    mockFetch([
      { data: [{ id: "camp-1", title: "Annual Fund" }], has_more: false },
      {
        data: [{
          id: "pay-2",
          campaign_id: "camp-1",
          amount: 50,
          buyer: { email: "stranger@example.com", first_name: "Unknown", last_name: "Donor" },
          created: 1700000000,
        }],
        has_more: false,
      },
    ]);
    mp.fundraiser.findUnique.mockResolvedValue({ id: "fundraiser-1" });
    mp.donation.findUnique.mockResolvedValue(null);
    mp.people.findFirst.mockResolvedValue(null); // no match
    mockTransaction();

    const result = await syncZeffyDonations(OFFICE_ID);

    expect(result).toEqual({ synced: 1, skipped: 0, errors: 0 });
    expect(mp.donation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          approvalStatus: "PENDING",
          peopleId: null,
        }),
      })
    );
  });

  it("skips a payment that has already been imported (idempotency)", async () => {
    mockApiKey();
    mockFetch([
      { data: [], has_more: false },                                      // campaigns
      { data: [{ id: "pay-dup", campaign_id: null, amount: 25 }], has_more: false }, // payments
    ]);
    mp.donation.findUnique.mockResolvedValue({ id: "existing-donation" }); // already in DB

    const result = await syncZeffyDonations(OFFICE_ID);

    expect(result).toEqual({ synced: 0, skipped: 1, errors: 0 });
    expect(mp.donation.create).not.toHaveBeenCalled();
  });

  it("creates a new fundraiser when the campaign is not yet in the database", async () => {
    mockApiKey();
    mockFetch([
      { data: [{ id: "camp-new", title: "New Campaign", goal_amount: 5000 }], has_more: false },
      {
        data: [{
          id: "pay-3",
          campaign_id: "camp-new",
          amount: 75,
          buyer: { email: "a@b.com" },
          created: 1700000000,
        }],
        has_more: false,
      },
    ]);
    mp.fundraiser.findUnique.mockResolvedValue(null);  // campaign not found — will create
    mp.fundraiser.create.mockResolvedValue({ id: "new-fundraiser" });
    mp.donation.findUnique.mockResolvedValue(null);
    mp.people.findFirst.mockResolvedValue(null);
    mockTransaction();

    await syncZeffyDonations(OFFICE_ID);

    expect(mp.fundraiser.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: "New Campaign",
          zeffyCampaignId: "camp-new",
          goalAmount: 500000, // $5000 → cents
        }),
      })
    );
  });

  it("uses a default fundraiser when payment has no campaign", async () => {
    mockApiKey();
    mockFetch([
      { data: [], has_more: false }, // no campaigns
      {
        data: [{
          id: "pay-4",
          campaign_id: null,
          amount: 20,
          buyer: { email: "x@y.com" },
          created: 1700000000,
        }],
        has_more: false,
      },
    ]);
    // findUnique: first call checks for "zeffy-general" fundraiser (not found), then creates it
    mp.fundraiser.findUnique.mockResolvedValue(null);
    mp.fundraiser.create.mockResolvedValue({ id: "default-fundraiser" });
    mp.donation.findUnique.mockResolvedValue(null);
    mp.people.findFirst.mockResolvedValue(null);
    mockTransaction();

    await syncZeffyDonations(OFFICE_ID);

    expect(mp.fundraiser.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ title: "Zeffy Donations" }),
      })
    );
  });

  it("handles multiple pages of payments via cursor pagination", async () => {
    mockApiKey();
    mockFetch([
      { data: [], has_more: false }, // campaigns
      {
        data: [{ id: "pay-a", campaign_id: null, amount: 10, buyer: { email: "a@a.com" }, created: 1700000000 }],
        has_more: true,
        next_cursor: "cursor-2",
      },
      {
        data: [{ id: "pay-b", campaign_id: null, amount: 20, buyer: { email: "b@b.com" }, created: 1700000001 }],
        has_more: false,
      },
    ]);
    mp.fundraiser.findUnique.mockResolvedValue(null);
    mp.fundraiser.create.mockResolvedValue({ id: "default-fundraiser" });
    mp.donation.findUnique.mockResolvedValue(null);
    mp.people.findFirst.mockResolvedValue(null);
    mockTransaction();

    const result = await syncZeffyDonations(OFFICE_ID);

    expect(result).toEqual({ synced: 2, skipped: 0, errors: 0 });
  });
});

// ─── syncZeffyContacts ────────────────────────────────────────────────────────

describe("syncZeffyContacts", () => {
  it("creates a new person from a Zeffy contact", async () => {
    mockApiKey();
    mockFetch([{
      data: [{
        email: "new@person.com",
        first_name: "Alice",
        last_name: "Smith",
        address: { line1: "123 Main St", city: "Springfield", state: "IL", postal_code: "62701" },
        phone_number: "555-1234",
      }],
      has_more: false,
    }]);
    mp.people.findFirst.mockResolvedValue(null); // no existing match
    mp.people.create.mockResolvedValue({ id: "new-person" });

    const result = await syncZeffyContacts(OFFICE_ID);

    expect(result).toEqual({ created: 1, skipped: 0, errors: 0, pendingDuplicates: [] });
    expect(mp.people.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          firstName: "Alice",
          lastName: "Smith",
          email1: "new@person.com",
          address: "123 Main St",
          city: "Springfield",
          state: "IL",
          zip: "62701",
          phoneNumber: "555-1234",
        }),
      })
    );
  });

  it("skips a contact with no email address", async () => {
    mockApiKey();
    mockFetch([{
      data: [{ first_name: "No", last_name: "Email" }], // no email field
      has_more: false,
    }]);

    const result = await syncZeffyContacts(OFFICE_ID);

    expect(result).toEqual({ created: 0, skipped: 1, errors: 0, pendingDuplicates: [] });
    expect(mp.people.create).not.toHaveBeenCalled();
  });

  it("skips a contact whose email already exists in the office", async () => {
    mockApiKey();
    mockFetch([{
      data: [{ email: "existing@person.com", first_name: "Bob", last_name: "Jones" }],
      has_more: false,
    }]);
    mp.people.findFirst.mockResolvedValue({ id: "already-exists" });

    const result = await syncZeffyContacts(OFFICE_ID);

    expect(result).toEqual({ created: 0, skipped: 1, errors: 0, pendingDuplicates: [] });
    expect(mp.people.create).not.toHaveBeenCalled();
  });

  it("falls back to 'Unknown' when first or last name is missing", async () => {
    mockApiKey();
    mockFetch([{
      data: [{ email: "noname@example.com" }],
      has_more: false,
    }]);
    mp.people.findFirst.mockResolvedValue(null);
    mp.people.create.mockResolvedValue({ id: "new-person" });

    await syncZeffyContacts(OFFICE_ID);

    expect(mp.people.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ firstName: "Unknown", lastName: "Unknown" }),
      })
    );
  });

  it("handles multiple pages of contacts via cursor pagination", async () => {
    mockApiKey();
    mockFetch([
      {
        data: [{ email: "p1@example.com", first_name: "P1", last_name: "One" }],
        has_more: true,
        next_cursor: "cursor-2",
      },
      {
        data: [{ email: "p2@example.com", first_name: "P2", last_name: "Two" }],
        has_more: false,
      },
    ]);
    mp.people.findFirst.mockResolvedValue(null);
    mp.people.create.mockResolvedValue({ id: "person" });

    const result = await syncZeffyContacts(OFFICE_ID);

    expect(result).toEqual({ created: 2, skipped: 0, errors: 0, pendingDuplicates: [] });
  });
});

// ─── processZeffyWebhookPayment ───────────────────────────────────────────────

describe("processZeffyWebhookPayment", () => {
  const basePayment = {
    id: "webhook-pay-1",
    campaign_id: "camp-1",
    campaign: { title: "Spring Gala" },
    amount: 200,
    buyer: { email: "donor@example.com", first_name: "Jane", last_name: "Doe" },
    created: 1700000000,
  };

  it("creates a donation for a new payment with a known donor", async () => {
    mp.donation.findUnique.mockResolvedValue(null);
    mp.fundraiser.findUnique.mockResolvedValue({ id: "fundraiser-1" });
    mp.people.findFirst.mockResolvedValue({ id: "person-1" });
    mp.donation.aggregate.mockResolvedValue({ _sum: { amount: 20000 } });
    mockTransaction();

    await processZeffyWebhookPayment(basePayment, OFFICE_ID);

    expect(mp.donation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          zeffyPaymentId: "webhook-pay-1",
          amount: 20000, // $200 → cents
          approvalStatus: "AUTO_APPROVED",
          peopleId: "person-1",
        }),
      })
    );
    // currentAmount is recomputed from SUM(donations) (recalcFundraiserTotal),
    // not incremented by a delta.
    expect(mp.fundraiser.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { currentAmount: 20000 },
      })
    );
  });

  it("skips a payment that has already been processed (idempotency)", async () => {
    mp.donation.findUnique.mockResolvedValue({ id: "existing" });

    await processZeffyWebhookPayment(basePayment, OFFICE_ID);

    expect(mp.donation.create).not.toHaveBeenCalled();
    expect(mp.fundraiser.update).not.toHaveBeenCalled();
  });

  it("creates a PENDING donation when the donor is not in the database", async () => {
    mp.donation.findUnique.mockResolvedValue(null);
    mp.fundraiser.findUnique.mockResolvedValue({ id: "fundraiser-1" });
    mp.people.findFirst.mockResolvedValue(null); // no match
    mockTransaction();

    await processZeffyWebhookPayment(basePayment, OFFICE_ID);

    expect(mp.donation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          approvalStatus: "PENDING",
          peopleId: null,
        }),
      })
    );
  });

  it("uses a default fundraiser when payment has no campaign", async () => {
    const paymentWithoutCampaign = { ...basePayment, campaign_id: null, campaign: null };
    mp.donation.findUnique.mockResolvedValue(null);
    mp.fundraiser.findUnique.mockResolvedValue(null);
    mp.fundraiser.create.mockResolvedValue({ id: "default-fundraiser" });
    mp.people.findFirst.mockResolvedValue(null);
    mockTransaction();

    await processZeffyWebhookPayment(paymentWithoutCampaign, OFFICE_ID);

    expect(mp.fundraiser.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ title: "Zeffy Donations" }),
      })
    );
  });

  it("converts unix timestamp to a Date for donatedAt", async () => {
    mp.donation.findUnique.mockResolvedValue(null);
    mp.fundraiser.findUnique.mockResolvedValue({ id: "fundraiser-1" });
    mp.people.findFirst.mockResolvedValue(null);
    mockTransaction();

    await processZeffyWebhookPayment(basePayment, OFFICE_ID);

    expect(mp.donation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          donatedAt: new Date(1700000000 * 1000),
        }),
      })
    );
  });
});

// ─── isValidZeffyWebhookToken ────────────────────────────────────────────────

describe("isValidZeffyWebhookToken", () => {
  it("accepts a matching token", () => {
    expect(isValidZeffyWebhookToken("abc123", "abc123")).toBe(true);
  });

  it("accepts a token when the stored secret has a trailing newline", () => {
    // The production secret carried a stray "\n" until September 2026, which
    // made a strict comparison reject every real webhook.
    expect(isValidZeffyWebhookToken("abc123", "abc123\n")).toBe(true);
  });

  it("ignores surrounding whitespace on the incoming token", () => {
    expect(isValidZeffyWebhookToken("  abc123 ", "abc123")).toBe(true);
  });

  it("rejects a wrong token", () => {
    expect(isValidZeffyWebhookToken("nope", "abc123")).toBe(false);
  });

  it("rejects a missing token", () => {
    expect(isValidZeffyWebhookToken(null, "abc123")).toBe(false);
  });

  it("fails closed when no secret is configured", () => {
    expect(isValidZeffyWebhookToken("abc123", undefined)).toBe(false);
    expect(isValidZeffyWebhookToken("", "")).toBe(false);
    expect(isValidZeffyWebhookToken("", "   \n")).toBe(false);
  });
});

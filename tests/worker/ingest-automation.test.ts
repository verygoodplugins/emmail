import { beforeEach, describe, expect, it } from "vitest";
import {
  createMailHarness,
  seedEnabledWelcomeSequence,
  type MailHarness,
} from "../helpers/mail-harness";
import { FOLLOWUP_SUBJECT, WELCOME_SUBJECT } from "../../src/email/welcome";

/**
 * Foundation scenario for automation/campaign builder work:
 * HTTP ingest → enroll → drain each step → assert rendered emails + events.
 *
 * Extend this file (or import the harness) when adding new step types,
 * template checks, or campaign send verification.
 */
describe("ingest → automation sequence", () => {
  let harness: MailHarness;

  beforeEach(async () => {
    harness = await createMailHarness();
  });

  it("runs welcome → wait → follow-up → tag after a contact-form ingest", async () => {
    const automation = await seedEnabledWelcomeSequence(harness);

    const response = await harness.ingest({
      id: 42,
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
    expect(response.status).toBe(200);

    const contact = await harness.contacts.getContactByEmail("ada@example.com");
    expect(contact).toMatchObject({
      email: "ada@example.com",
      first_name: "Ada",
      last_name: "Lovelace",
      status: "subscribed",
    });

    const automationJobs = harness
      .queuedMessages()
      .filter((entry) => entry.body.type === "automation");
    expect(automationJobs).toHaveLength(1);
    expect(harness.queuedMessages().some((entry) => entry.body.type === "welcome")).toBe(false);

    const enrollmentId = String(automationJobs[0].body.enrollmentId);

    // Step 1: send welcome email, then park on wait.
    const afterWelcome = await harness.drainAutomation(enrollmentId);
    expect(afterWelcome).toMatchObject({
      status: "waiting",
      stepsRun: expect.any(Number),
    });
    expect(harness.emails).toHaveLength(1);
    expect(harness.emails[0].message).toMatchObject({
      to: ["ada@example.com"],
      subject: WELCOME_SUBJECT,
    });
    expect(harness.emails[0].message.html).toContain("Ada");
    expect(harness.emails[0].message.html).toContain("South &amp; Ozarks");
    expect(harness.emails[0].idempotencyKey).toBe(
      `automation/${enrollmentId}/${automation.steps[0].id}`
    );

    let enrollment = await harness.automations.getEnrollment(enrollmentId);
    expect(enrollment).toMatchObject({ status: "waiting", currentPosition: 1 });

    // Step 2–4: wait due → follow-up email → tag → complete.
    await harness.forceWaitDue(enrollmentId);
    const afterFollowup = await harness.drainAutomation(enrollmentId);
    expect(afterFollowup.status).toBe("completed");
    expect(harness.emails).toHaveLength(2);
    expect(harness.emails[1].message.subject).toBe(FOLLOWUP_SUBJECT);
    expect(harness.emails[1].message.html).toContain("Ada");

    enrollment = await harness.automations.getEnrollment(enrollmentId);
    expect(enrollment?.status).toBe("completed");

    const refreshed = (await harness.contacts.listContacts({ limit: 10, offset: 0 }))[0];
    expect(refreshed.tags).toContain("welcome-sequence-complete");

    const eventTypes = await harness.contactEventTypes(contact!.id);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "contact_ingested",
        "automation_enrolled",
        "automation_email_sent",
        "automation_tag_added",
        "automation_completed",
      ])
    );
    expect(eventTypes.filter((type) => type === "automation_email_sent")).toHaveLength(2);
  });

  it("does not enroll when the sequence is still disabled", async () => {
    await harness.automations.ensureWelcomeSequence();

    const response = await harness.ingest({
      id: 7,
      name: "Grace Hopper",
      email: "grace@example.com",
    });
    expect(response.status).toBe(200);
    expect(
      harness.queuedMessages().filter((entry) => entry.body.type === "automation")
    ).toHaveLength(0);
  });

  it("keeps one-shot welcome and multi-step sequence independent", async () => {
    harness.env.EMMAIL_WELCOME_ENABLED = "true";
    await seedEnabledWelcomeSequence(harness);

    await harness.ingest({
      id: 9,
      name: "Double Fire",
      email: "double@example.com",
    });

    const types = harness.queuedMessages().map((entry) => entry.body.type);
    expect(types).toContain("welcome");
    expect(types).toContain("automation");
  });

  it("exposes rendered template fields for future builder assertions", async () => {
    await seedEnabledWelcomeSequence(harness);
    await harness.ingest({
      id: 11,
      name: "Template Probe",
      email: "probe@example.com",
    });
    const enrollmentId = String(
      harness.queuedMessages().find((entry) => entry.body.type === "automation")!.body.enrollmentId
    );

    await harness.drainAutomation(enrollmentId);
    const [welcome] = harness.emails;
    expect(welcome.message.subject).toBe(WELCOME_SUBJECT);
    expect(welcome.message.text).toContain("Template");
    expect(welcome.message.html).toMatch(/Hi Template,/);
    expect(welcome.message.headers["List-Unsubscribe"]).toMatch(
      /^<https:\/\/mail\.example\.com\/unsubscribe\/c\//
    );
  });
});

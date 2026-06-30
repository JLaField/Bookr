import express, { Application, Request, Response } from "express";
import { Client } from "@hubspot/api-client";
import { FilterOperatorEnum } from "@hubspot/api-client/lib/codegen/crm/contacts/models/Filter";

// Types for handling Retell Payload

interface RetellCustomAnalysisData {
  estimate_requested?: boolean;
  preferred_time?: string; // free text, e.g. "Wednesday, July 2, 2025 at 12:00 PM Pacific"
  site_address?: string;
  customer_email?: string;
  customer_phone?: string;
  customer_name?: string;
  job_scope?: string;
  [key: string]: unknown;
}

interface RetellCallAnalysis {
  call_summary: string;
  in_voicemail: boolean;
  user_sentiment: string;
  call_successful: boolean;
  custom_analysis_data: RetellCustomAnalysisData;
}

interface RetellCollectedDynamicVariables {
  previous_node?: string;
  current_node?: string;
  preferred_time?: string;
  site_address?: string;
  customer_email?: string;
  customer_phone?: string;
  customer_name?: string;
  job_scope?: string;
  [key: string]: unknown;
}

interface RetellCall {
  call_type: string;
  call_id: string;
  agent_id: string;
  agent_version?: number;
  agent_name?: string;
  call_status: string;
  from_number: string;
  to_number: string;
  direction: string;
  start_timestamp: number;
  end_timestamp: number;
  duration_ms: number;
  disconnection_reason: string;
  recording_url?: string;
  public_log_url?: string;
  retell_llm_dynamic_variables?: Record<string, unknown>;
  collected_dynamic_variables?: RetellCollectedDynamicVariables;
  call_analysis: RetellCallAnalysis;
}

interface RetellWebhookPayload {
  event: string;
  call: RetellCall;
}

const app: Application = express();
const PORT = 8080;

// Middleware to parse incoming JSON requests
app.use(express.json());

// Fetch the service key from the Cloud Run environment variable
const hubspotKey = process.env.HUBSPOT_KEY;

if (!hubspotKey) {
  throw new Error("Missing HUBSPOT_KEY environment variable.");
}

// Initialize the HubSpot client using the Service Key as the accessToken
const hubspotClient = new Client({ accessToken: hubspotKey });

// Route to get contacts from HubSpot
app.get("/contacts", async (req: Request, res: Response) => {
  const result = await getContacts();
  if (result !== undefined) {
    res.status(200).json({ contacts: result });
  }
});

// Route to create contact and appointment from Retell call
app.post("/webhooks/retell", async (req: Request, res: Response) => {
  try {
    const payload = req.body as RetellWebhookPayload;

    if (payload.event !== "call_analyzed") {
      // Acknowledge but ignore events we don't care about
      return res.status(200).json({ received: true, skipped: true });
    }

    const { call } = payload;
    const custom = call.call_analysis?.custom_analysis_data ?? {};

    if (!custom.estimate_requested) {
      // Nothing to create in HubSpot for this call
      return res.status(200).json({ received: true, estimateRequested: false });
    }

    const contactInfo = extractContactInfo(call);
    const contactId = await upsertContact(contactInfo);

    const { startMs, endMs, parsed } = resolveAppointmentTime(
      contactInfo.preferredTime
    );

    const meetingId = await createAppointment({
      contactId,
      call,
      jobScope: contactInfo.jobScope,
      address: contactInfo.address,
      startMs,
      endMs,
      timeWasParsed: parsed
    });

    return res.status(200).json({
      received: true,
      contactId,
      meetingId
    });
  } catch (err) {
    console.error("Error processing Retell webhook:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- Helpers ----------

/**
 * Pulls contact info out of the call payload. The agent collects these as
 * structured fields in `collected_dynamic_variables` (mirrored in
 * `custom_analysis_data`), so we prefer those over guessing from raw call
 * metadata. Falls back to the call's from/to number if no phone was
 * explicitly collected.
 */
function extractContactInfo(call: RetellCall) {
  const collected = call.collected_dynamic_variables ?? {};
  const custom = call.call_analysis?.custom_analysis_data ?? {};

  const fullName = collected.customer_name || custom.customer_name || "";
  const [firstName, ...rest] = fullName.trim().split(/\s+/).filter(Boolean);
  const lastName = rest.join(" ");

  const emailRaw = collected.customer_email || custom.customer_email || "";
  const email = emailRaw.trim() ? emailRaw.trim() : undefined;

  const phoneRaw =
    collected.customer_phone ||
    custom.customer_phone ||
    (call.direction === "inbound" ? call.from_number : call.to_number);
  const phone = normalizePhone(phoneRaw);

  const address = collected.site_address || custom.site_address || undefined;
  const jobScope = collected.job_scope || custom.job_scope || undefined;
  const preferredTime =
    collected.preferred_time || custom.preferred_time || undefined;

  return {
    firstName: firstName || undefined,
    lastName: lastName || undefined,
    email,
    phone,
    address,
    jobScope,
    preferredTime
  };
}

/**
 * Best-effort normalization so "1234567890" and "+11234567890" don't end up
 * as separate contacts. Assumes US numbers when no country code is present.
 */
function normalizePhone(raw?: string): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return undefined;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw.startsWith("+") ? raw : `+${digits}`;
}

/**
 * Parses the free-text `preferred_time` string (e.g. "Wednesday, July 2,
 * 2025 at 12:00 PM Pacific") into a millisecond timestamp. JS's Date parser
 * handles most of these natural-language formats directly; if parsing
 * fails, falls back to "now" so the meeting is still created and can be
 * corrected manually in HubSpot. Defaults to a 60 minute duration, since
 * these are typically on-site estimate visits.
 */
function resolveAppointmentTime(preferredTime?: string): {
  startMs: number;
  endMs: number;
  parsed: boolean;
} {
  let start: Date | undefined;

  if (preferredTime) {
    // Strip trailing timezone names like "Pacific"/"Eastern" that Date.parse
    // doesn't reliably understand, and let it parse the rest.
    const cleaned = preferredTime
      .replace(/\b(Pacific|Eastern|Central|Mountain)\b\s*$/i, "")
      .trim();
    const candidate = new Date(cleaned);
    if (!isNaN(candidate.getTime())) {
      start = candidate;
    }
  }

  const parsed = !!start;
  if (!start) start = new Date();

  const durationMs = 60 * 60 * 1000; // 60 minute default for on-site estimates
  return {
    startMs: start.getTime(),
    endMs: start.getTime() + durationMs,
    parsed
  };
}

/**
 * Finds an existing HubSpot contact by phone (or email if available),
 * or creates a new one. Returns the contact ID.
 */
async function upsertContact(info: {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  address?: string;
}): Promise<string> {
  const searchFilters: {
    propertyName: string;
    operator: FilterOperatorEnum;
    value: string;
  }[] = [];

  if (info.email) {
    searchFilters.push({
      propertyName: "email",
      operator: FilterOperatorEnum.Eq,
      value: info.email
    });
  } else if (info.phone) {
    searchFilters.push({
      propertyName: "phone",
      operator: FilterOperatorEnum.Eq,
      value: info.phone
    });
  }

  if (searchFilters.length > 0) {
    const searchResult = await hubspotClient.crm.contacts.searchApi.doSearch({
      filterGroups: [{ filters: searchFilters }],
      properties: ["firstname", "lastname", "email", "phone", "address"],
      limit: 1
    });

    if (searchResult.results.length > 0) {
      const existingId = searchResult.results[0].id;

      // Update with any new info we have (non-destructive merge)
      await hubspotClient.crm.contacts.basicApi.update(existingId, {
        properties: {
          ...(info.firstName ? { firstname: info.firstName } : {}),
          ...(info.lastName ? { lastname: info.lastName } : {}),
          ...(info.email ? { email: info.email } : {}),
          ...(info.phone ? { phone: info.phone } : {}),
          ...(info.address ? { address: info.address } : {})
        }
      });

      return existingId;
    }
  }

  // No match found (or nothing to search on) -> create new contact
  const created = await hubspotClient.crm.contacts.basicApi.create({
    properties: {
      ...(info.firstName ? { firstname: info.firstName } : {}),
      ...(info.lastName ? { lastname: info.lastName } : {}),
      ...(info.email ? { email: info.email } : {}),
      ...(info.phone ? { phone: info.phone } : {}),
      ...(info.address ? { address: info.address } : {})
    }
  });

  return created.id;
}

/**
 * Creates a Meeting engagement in HubSpot, associated with the given
 * contact, representing the requested on-site estimate/appointment.
 */
async function createAppointment(params: {
  contactId: string;
  call: RetellCall;
  jobScope?: string;
  address?: string;
  startMs: number;
  endMs: number;
  timeWasParsed: boolean;
}): Promise<string> {
  const { contactId, call, jobScope, address, startMs, endMs, timeWasParsed } =
    params;

  const bodyParts = [call.call_analysis.call_summary];
  if (jobScope) bodyParts.push(`Job scope: ${jobScope}`);
  if (address) bodyParts.push(`Site address: ${address}`);
  if (!timeWasParsed) {
    bodyParts.push(
      "NOTE: Could not automatically parse the requested appointment time from the call; defaulted to call time. Please confirm with the customer."
    );
  }

  const meeting = await hubspotClient.crm.objects.meetings.basicApi.create({
    properties: {
      hs_meeting_title: "Estimate appointment requested via AI call agent",
      hs_meeting_body: bodyParts.join("\n\n"),
      hs_meeting_start_time: new Date(startMs).toISOString(),
      hs_meeting_end_time: new Date(endMs).toISOString(),
      hs_meeting_outcome: "SCHEDULED",
      hs_internal_meeting_notes: `Call ID: ${call.call_id}\nRecording: ${
        call.recording_url ?? "N/A"
      }`
    },
    associations: [
      {
        to: { id: contactId },
        types: [
          {
            associationCategory: "HUBSPOT_DEFINED" as any,
            associationTypeId: 200 // meeting-to-contact association type
          }
        ]
      }
    ]
  });

  return meeting.id;
}

// Gets contacts from HubSpot API
async function getContacts() {
  try {
    // Make your REST API call via the SDK client
    const response = await hubspotClient.crm.contacts.basicApi.getPage(10);
    return response.results;
  } catch (error) {
    console.error("Error fetching HubSpot data:", error);
    throw error;
  }
}

// Start listening
app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});

import express, { Application, Request, Response } from "express";
import { Client } from "@hubspot/api-client";
import { FilterOperatorEnum } from "@hubspot/api-client/lib/codegen/crm/contacts/models/Filter";

// Types for handling Retell Payload

interface RetellCustomAnalysisData {
  appointment_booked?: boolean;
  appointment_date?: string; // e.g. "2024-05-07"
  appointment_time?: string; // not always present, handled defensively
  [key: string]: unknown;
}

interface RetellCallAnalysis {
  call_summary: string;
  in_voicemail: boolean;
  user_sentiment: string;
  call_successful: boolean;
  custom_analysis_data: RetellCustomAnalysisData;
}

interface RetellCall {
  call_type: string;
  call_id: string;
  agent_id: string;
  call_status: string;
  from_number: string;
  to_number: string;
  direction: string;
  start_timestamp: number;
  end_timestamp: number;
  duration_ms: number;
  disconnection_reason: string;
  transcript: string;
  transcript_object: unknown[];
  transcript_with_tool_calls: unknown[];
  recording_url?: string;
  public_log_url?: string;
  metadata?: Record<string, unknown>;
  retell_llm_dynamic_variables?: Record<string, unknown>;
  opt_out_sensitive_data_storage: boolean;
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

// Basic Route
app.get("/", (req: Request, res: Response) => {
  res.status(200).json({ message: "Hello from TypeScript Server!" });
});

// Route to get contacts from HubSpot
app.get("/contacts", async (req: Request, res: Response) => {
  const result = await getContacts();
  if (result !== undefined) {
    res.status(200).json({ contacts: result });
  }
});

// Route to create contact and appointment from Retell Webhook
app.post("/webhooks/retell", async (req: Request, res: Response) => {
  try {
    const payload = req.body as RetellWebhookPayload;

    if (payload.event !== "call_analyzed") {
      // Acknowledge but ignore events we don't care about
      return res.status(200).json({ received: true, skipped: true });
    }

    const { call } = payload;
    const custom = call.call_analysis?.custom_analysis_data ?? {};

    if (!custom.appointment_booked) {
      // Nothing to create in HubSpot for this call
      return res.status(200).json({ received: true, appointmentBooked: false });
    }

    const contactInfo = extractContactInfo(call);
    const contactId = await upsertContact(contactInfo);

    const { startMs, endMs } = resolveAppointmentTime(custom);
    const meetingId = await createAppointment({
      contactId,
      call,
      startMs,
      endMs
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
 * Pulls a usable phone number, name, and email out of the call payload.
 * Retell doesn't give you a structured "caller name/email" field by default,
 * so we fall back to dynamic variables (commonly populated by your agent
 * prompt/config) and otherwise leave fields blank.
 */
function extractContactInfo(call: RetellCall) {
  const dynamicVars = call.retell_llm_dynamic_variables ?? {};

  const fullName =
    (dynamicVars["customer_name"] as string | undefined) ??
    (dynamicVars["name"] as string | undefined) ??
    "";

  const [firstName, ...rest] = fullName.trim().split(/\s+/).filter(Boolean);
  const lastName = rest.join(" ");

  const email =
    (dynamicVars["customer_email"] as string | undefined) ??
    (dynamicVars["email"] as string | undefined) ??
    undefined;

  const phone =
    call.direction === "inbound" ? call.from_number : call.to_number;

  return {
    firstName: firstName || undefined,
    lastName: lastName || undefined,
    email,
    phone
  };
}

/**
 * Parses the appointment date (and optional time) from custom_analysis_data
 * into a millisecond timestamp HubSpot can use for the meeting start time.
 * Defaults to 9:00 AM local server time if no time is provided, and defaults
 * to a 30 minute duration.
 */
function resolveAppointmentTime(custom: RetellCustomAnalysisData): {
  startMs: number;
  endMs: number;
} {
  const dateStr = custom.appointment_date; // "2024-05-07"
  const timeStr = custom.appointment_time; // optional, e.g. "14:00"

  let start: Date;
  if (dateStr) {
    const isoString = timeStr
      ? `${dateStr}T${timeStr}:00`
      : `${dateStr}T09:00:00`;
    start = new Date(isoString);
    if (isNaN(start.getTime())) {
      // Fallback if parsing fails
      start = new Date();
    }
  } else {
    start = new Date();
  }

  const durationMs = 30 * 60 * 1000; // 30 minute default appointment
  return { startMs: start.getTime(), endMs: start.getTime() + durationMs };
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
      properties: ["firstname", "lastname", "email", "phone"],
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
          ...(info.phone ? { phone: info.phone } : {})
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
      ...(info.phone ? { phone: info.phone } : {})
    }
  });

  return created.id;
}

/**
 * Creates a Meeting engagement in HubSpot, associated with the given
 * contact, representing the booked appointment.
 */
async function createAppointment(params: {
  contactId: string;
  call: RetellCall;
  startMs: number;
  endMs: number;
}): Promise<string> {
  const { contactId, call, startMs, endMs } = params;

  const meeting = await hubspotClient.crm.objects.meetings.basicApi.create({
    properties: {
      hs_meeting_title: "Appointment booked via AI call agent",
      hs_meeting_body: call.call_analysis.call_summary,
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

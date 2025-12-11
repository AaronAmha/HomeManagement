import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";
import twilio from "twilio";
import { triageMessage } from "./ai/triage";

// ---------------- Firebase Admin ----------------
if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

// ---------------- Secrets ----------------
const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const TWILIO_ACCOUNT_SID = defineSecret("TWILIO_ACCOUNT_SID");
const TWILIO_AUTH_TOKEN = defineSecret("TWILIO_AUTH_TOKEN");
const TWILIO_FROM_NUMBER = defineSecret("TWILIO_FROM_NUMBER");

// ---------------- Twilio Lazy Init ----------------
let twilioClient: twilio.Twilio | null = null;
let twilioFrom: string | null = null;

function initTwilioOnce() {
  if (twilioClient) return;

  const sid = TWILIO_ACCOUNT_SID.value();
  const token = TWILIO_AUTH_TOKEN.value();
  const from = TWILIO_FROM_NUMBER.value();

  if (!sid || !token || !from) {
    console.warn("Twilio not fully configured; skipping SMS.");
    return;
  }

  twilioClient = twilio(sid, token);
  twilioFrom = from;
}

// ---------------- Types (lightweight) ----------------
type Tenant = {
  id: string;
  phone: string;
  landlordId?: string | null;
  unitId?: string | null;
  name?: string;
  fullName?: string;
  firstName?: string;
  displayName?: string;
};

type Ticket = {
  id: string;
  tenantId: string;
  landlordId?: string | null;
  unitId?: string | null;
  status: string;
  issueType?: string | null;
  emergencyFlag?: boolean;
  pendingClarification?: boolean;
  pendingClarificationField?: "location" | "details" | null;
  locationDescription?: string | null;
};

type TriageResult = {
  issueType: string;
  emergency: boolean;
  needsClarification: boolean;
  clarificationQuestion: string | null;
  // we can extend later with: riskLevel, missingFields, etc.
};

// ---------------- Helpers ----------------
function resolveTenantName(tenant: any): string {
  return (
    tenant.name ||
    tenant.fullName ||
    tenant.firstName ||
    tenant.displayName ||
    ""
  );
}

async function getLandlordById(id: string): Promise<any | null> {
  const doc = await db.collection("landlords").doc(id).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

async function findTenantByPhone(phone: string): Promise<Tenant | null> {
  const snap = await db
    .collection("tenants")
    .where("phone", "==", phone)
    .limit(1)
    .get();

  if (snap.empty) return null;

  const doc = snap.docs[0];
  return { id: doc.id, ...(doc.data() as any) };
}

async function getOrCreateOpenTicketForTenant(
  tenant: Tenant
): Promise<Ticket> {
  const snap = await db
    .collection("tickets")
    .where("tenantId", "==", tenant.id)
    .orderBy("createdAt", "desc")
    .limit(1)
    .get();

  if (!snap.empty) {
    const doc = snap.docs[0];
    const data = doc.data() as any;
    if (data.status !== "completed" && data.status !== "closed") {
      return { id: doc.id, ...data };
    }
  }

const ref = await db.collection("tickets").add({
  tenantId: tenant.id,
  landlordId: tenant.landlordId || null,
  unitId: tenant.unitId || null,
  status: "open",
  issueType: null,
  emergencyFlag: false,
  pendingClarification: false,
  pendingClarificationField: null,
  locationDescription: null,
  createdAt: admin.firestore.FieldValue.serverTimestamp(),
  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
});

  const snap2 = await ref.get();
  return { id: ref.id, ...(snap2.data() as any) };
}

async function addTicketMessage(
  ticketId: string,
  senderType: "tenant" | "landlord" | "system",
  body: string,
  direction: "inbound" | "outbound"
) {
  await db.collection("ticketMessages").add({
    ticketId,
    senderType,
    body,
    direction,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await db.collection("tickets").doc(ticketId).update({
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastMessage: body,
  });
}

// ---------------- Main Inbound Handler ----------------
export const smsInbound = onRequest(
  {
    secrets: [
      OPENAI_API_KEY,
      TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN,
      TWILIO_FROM_NUMBER,
    ],
  },
  async (req, res) => {
    // Optional: enforce POST only
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    try {
      const from = req.body.From?.trim();
      const body = req.body.Body?.trim();

      console.log("smsInbound received:", { from, body });

      if (!from || !body) {
        res.set("Content-Type", "text/xml");
        res.status(200).send(
          `<Response><Message>We received an empty message.</Message></Response>`
        );
        return;
      }

      // 1) Find tenant
      const tenant = await findTenantByPhone(from);

      if (!tenant) {
        console.warn("Unknown tenant phone:", from);

        await db.collection("unknownMessages").add({
          from,
          body,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        res.set("Content-Type", "text/xml");
        res
          .status(200)
          .send(
            `<Response><Message>We don't recognize this number yet. Please reply with your full name and unit address so we can connect you.</Message></Response>`
          );
        return;
      }

// 2) Get or create ticket
const ticket = await getOrCreateOpenTicketForTenant(tenant);
console.log("Using ticket", ticket.id, "for tenant", tenant.id);

// 3) Save inbound message
try {
  await addTicketMessage(ticket.id, "tenant", body, "inbound");
} catch (err) {
  console.error("Error saving inbound ticket message:", err);
}

// ---- 3.5) Heuristic: is this likely a short follow-up answer? ----
const isShortFollowup =
  body.length < 40 &&
  /kitchen|bathroom|bath|living room|livingroom|bedroom|hallway|ceiling|under the sink|under sink/i.test(
    body
  );

if (ticket.issueType && isShortFollowup) {
  const tenantName = resolveTenantName(tenant);
  const issueLabel =
    ticket.issueType && ticket.issueType !== "general"
      ? ticket.issueType
      : "issue";

  const replyText = `Thanks ${
    tenantName || ""
  }, I’ve added that detail to your ${issueLabel} ticket. I’ll coordinate with your landlord and keep you updated.`;

  try {
    await addTicketMessage(ticket.id, "system", replyText, "outbound");
  } catch (err) {
    console.error("Error saving outbound ticket message:", err);
  }

  res.set("Content-Type", "text/xml");
  res
    .status(200)
    .send(`<Response><Message>${replyText}</Message></Response>`);
  return; // ⬅️ IMPORTANT: we stop here, no triage
}

      // 4) AI triage
      let triage: TriageResult;
      try {
        const key = OPENAI_API_KEY.value();
        triage = await triageMessage(body, key);
      } catch (err) {
        console.error("triageMessage failed:", err);
        triage = {
          issueType: "general",
          emergency: false,
          needsClarification: false,
          clarificationQuestion: null,
        };
      }
      console.log("DEBUG: triage result =", triage);

      // 5) Update ticket with triage info
    // 5) Update ticket with triage info
    const ticketUpdate: any = {
    issueType: triage.issueType,
    emergencyFlag: triage.emergency,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (triage.needsClarification && triage.clarificationQuestion) {
    ticketUpdate.pendingClarification = true;
    ticketUpdate.pendingClarificationField = "location"; // for now, we only ask about location
    } else {
    ticketUpdate.pendingClarification = false;
    ticketUpdate.pendingClarificationField = null;
    }

    await db.collection("tickets").doc(ticket.id).update(ticketUpdate);

      // 6) Notify landlord
      if (tenant.landlordId) {
        const landlord = await getLandlordById(tenant.landlordId);

        if (landlord?.phone) {
          initTwilioOnce();

          if (twilioClient && twilioFrom) {
            const shortBody =
              body.length > 140 ? body.slice(0, 137) + "..." : body;

            const emergencyTag = triage.emergency ? "[EMERGENCY] " : "";
            const smsBody = `${emergencyTag}New issue from ${resolveTenantName(
              tenant
            ) || "tenant"} (Unit ${tenant.unitId || "?"})
Ticket: ${ticket.id}
Type: ${triage.issueType}
Emergency: ${triage.emergency ? "YES" : "No"}
Message: "${shortBody}"`;

            try {
              await twilioClient.messages.create({
                from: twilioFrom,
                to: landlord.phone,
                body: smsBody,
              });
            } catch (err) {
              console.error("Error sending Twilio landlord SMS:", err);
            }
          }
        }
      }

      // 7) Build tenant reply
      const tenantName = resolveTenantName(tenant);
      const issueLabel =
        triage.issueType && triage.issueType !== "general"
          ? triage.issueType
          : "issue";

      let replyText: string;

      if (triage.needsClarification && triage.clarificationQuestion) {
        replyText = `Thanks ${
          tenantName || ""
        }, I’ve logged this as a ${issueLabel}. ${
          triage.clarificationQuestion
        }`;
      } else if (triage.emergency) {
        replyText = `Thanks ${
          tenantName || ""
        }, I’ve logged this as an urgent ${issueLabel} and alerted your landlord immediately. If there's any immediate danger to health or safety, please contact emergency services as well.`;
      } else {
        replyText = `Thanks ${
          tenantName || ""
        }, I’ve logged this as a ${issueLabel}. I’ll coordinate with your landlord and keep you updated.`;
      }

      // 8) Save outbound message (system to tenant)
  // 8) Save outbound message (system to tenant)
    try {
    await addTicketMessage(ticket.id, "system", replyText, "outbound");
    } catch (err) {
    console.error("Error saving outbound ticket message:", err);
    }
      // 9) Respond as TwiML
      res.set("Content-Type", "text/xml");
      res.status(200).send(`<Response><Message>${replyText}</Message></Response>`);
    } catch (err) {
      console.error("Error in smsInbound:", err);

      res.set("Content-Type", "text/xml");
      res
        .status(200)
        .send(
          `<Response><Message>We had an error but received your message.</Message></Response>`
        );
    }
  }
);
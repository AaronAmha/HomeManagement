import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { triageMessage } from "./ai/triage";   
import twilio from "twilio";

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();
const twilioClient = twilio(
  functions.config().twilio.sid,
  functions.config().twilio.token
);

async function getLandlordById(id: string) {
  const doc = await db.collection("landlords").doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() } as any;
} 
// ---------- Helper: find tenant by phone ----------
async function findTenantByPhone(phone: string) {
  const snap = await db
    .collection("tenants")
    .where("phone", "==", phone)
    .limit(1)
    .get();

  if (snap.empty) return null;

  const doc = snap.docs[0];
  return {
    id: doc.id,
    ...doc.data(),
  } as any;
}

// ---------- Helper: get or create an open ticket ----------
// ---------- Helper: get or create an open ticket ----------
async function getOrCreateOpenTicketForTenant(tenant: any) {
  // Try to find ANY non-closed ticket for this tenant
  const snap = await db
    .collection("tickets")
    .where("tenantId", "==", tenant.id)
    .limit(1)
    .get();

  if (!snap.empty) {
    const doc = snap.docs[0];
    const data = doc.data();
    if (data.status !== "completed" && data.status !== "closed") {
      return { id: doc.id, ...data } as any;
    }
  }

  // Otherwise create a new ticket
  const ticketRef = await db.collection("tickets").add({
    tenantId: tenant.id,
    landlordId: tenant.landlordId || null, // assuming you'll store this on tenant
    unitId: tenant.unitId || null,
    status: "open",
    issueType: null,
    description: null,
    emergencyFlag: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const ticketSnap = await ticketRef.get();
  return { id: ticketRef.id, ...ticketSnap.data() } as any;
}

// ---------- Helper: create a ticket message ----------
async function addTicketMessage(ticketId: string, senderType: string, body: string) {
  await db.collection("ticketMessages").add({
    ticketId,
    senderType, // 'tenant' for now
    body,
    direction: "inbound",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await db.collection("tickets").doc(ticketId).update({
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    // optionally store lastMessage for dashboard
    lastMessage: body,
  });
}

// ---------- Main SMS handler ----------
export const smsInbound = functions.https.onRequest(async (req, res) => {
  try {
    const from = req.body.From as string | undefined;
    const body = (req.body.Body as string | undefined)?.trim();

    if (!from || !body) {
      res.set("Content-Type", "text/xml");
      res.status(200).send(`
        <Response>
          <Message>We received an empty message. Please try again.</Message>
        </Response>
      `);
      return;
    }

    // 1) Find tenant by phone
    const tenant = await findTenantByPhone(from);

    if (!tenant) {
      // Unknown number: log and ask them to identify
      await db.collection("unknownMessages").add({
        from,
        body,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.set("Content-Type", "text/xml");
      res.status(200).send(`
        <Response>
          <Message>Thanks for your message. Please reply with your full name and unit address so we can help.</Message>
        </Response>
      `);
      return;
    }

    // 2) Get or create an open ticket
    const ticket = await getOrCreateOpenTicketForTenant(tenant);

    // 3) Attach this message to ticket
    await addTicketMessage(ticket.id, "tenant", body);

    // 4) Run AI triage on the message
    const triage = await triageMessage(body);

    // 5) Update ticket with triage info
    await db.collection("tickets").doc(ticket.id).update({
      issueType: triage.issueType,
      emergencyFlag: triage.emergency,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 6) Notify landlord (if we have one)
    if (tenant.landlordId) {
      const landlord = await getLandlordById(tenant.landlordId);
      if (landlord && landlord.phone) {
        const shortBody = body.length > 140 ? body.slice(0, 137) + "..." : body;

        await twilioClient.messages.create({
          from: functions.config().twilio.from,
          to: landlord.phone,
          body: `New issue from ${tenant.name || "tenant"} (Unit ${
            tenant.unitId || "?"
          })\nType: ${triage.issueType}\nEmergency: ${
            triage.emergency ? "YES" : "No"
          }\nMessage: "${shortBody}"`,
        });
      }
    }

    // 7) Construct reply to tenant
    let replyText: string;

    if (triage.needsClarification && triage.clarificationQuestion) {
      replyText = triage.clarificationQuestion;
    } else {
      const label =
        triage.issueType && triage.issueType !== "general"
          ? triage.issueType
          : "issue";

      replyText = `Thanks ${
        tenant.name || ""
      }, I’ve logged this as a ${label}. I’ll coordinate with your landlord.`;
    }

    // 8) Respond to tenant
    res.set("Content-Type", "text/xml");
    res.status(200).send(`
      <Response>
        <Message>${replyText}</Message>
      </Response>
    `);
  } catch (err) {
    console.error("Error in smsInbound:", err);
    res.set("Content-Type", "text/xml");
    res.status(200).send(`
      <Response>
        <Message>We ran into an error on our side, but we received your message.</Message>
      </Response>
    `);
  }
});
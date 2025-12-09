// functions/src/ai/triage.ts
import * as functions from "firebase-functions";
import OpenAI from "openai";

export type TriageResult = {
  issueType: string;
  emergency: boolean;
  needsClarification: boolean;
  clarificationQuestion?: string;
};

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    const apiKey =
      process.env.OPENAI_API_KEY || functions.config().openai?.key;

    if (!apiKey) {
      console.error("OpenAI API key missing in env/config");
      throw new Error(
        "Missing OpenAI API key. Set OPENAI_API_KEY or functions.config().openai.key"
      );
    }

    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

const SYSTEM_PROMPT = `
You are an AI assistant for a property management company.
Your job is to TRIAGE tenant maintenance messages.

You must:
- Classify the issueType: one of
  ['plumbing','hvac','electrical','appliance','security','general','question','other'].
- Set emergency = true only if there is clear risk of:
  - active water damage (leak, flooding, overflowing toilet, burst pipe),
  - no heat in winter,
  - electrical fire risk (burning smell, sparks, smoke),
  - gas smell,
  - security issue (door won't lock, break-in).
- NEVER ask "is this an emergency?".
- Instead, if more info is needed, ask a SINGLE operational clarifying question, like:
  - "Is water actively spreading or is it just dripping slowly?"
  - "Is the heat completely out or partially working?"
  - "Is the toilet overflowing right now or just clogged?"
- If no clarification is needed, set needsClarification=false and clarificationQuestion empty.

You must respond ONLY in valid JSON with keys:
  issueType, emergency, needsClarification, clarificationQuestion.
`;

export async function triageMessage(
  messageText: string
): Promise<TriageResult> {
  const openai = getOpenAI();

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Tenant message: "${messageText}"`,
      },
    ],
    response_format: { type: "json_object" },
  });

  const raw = completion.choices[0]?.message?.content || "{}";
  let parsed: any;

  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error("Failed to parse triage JSON:", raw, e);
    return {
      issueType: "general",
      emergency: false,
      needsClarification: true,
      clarificationQuestion:
        "Can you send a photo and a short description of what’s going on?",
    };
  }

  return {
    issueType: parsed.issueType || "general",
    emergency: !!parsed.emergency,
    needsClarification: !!parsed.needsClarification,
    clarificationQuestion: parsed.clarificationQuestion || undefined,
  };
}
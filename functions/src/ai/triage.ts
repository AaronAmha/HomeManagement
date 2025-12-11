import OpenAI from "openai";

export type IssueType = "plumbing" | "hvac" | "appliance" | "general";

export type RiskLevel = "low" | "medium" | "high";

export type TriageResult = {
  issueType: IssueType;
  emergency: boolean;
  riskLevel: RiskLevel;
  needsClarification: boolean;
  clarificationQuestion: string | null;
  missingFields: {
    locationDetails: boolean;    // e.g. "under kitchen sink", "ceiling in living room"
    accessWindow: boolean;       // e.g. "morning / afternoon / evening"
    severityDetails: boolean;    // e.g. "small drip vs pouring water"
    applianceOrFixture: boolean; // e.g. "dishwasher vs washing machine vs toilet"
  };
};

const SYSTEM_PROMPT = `
You are an AI triage assistant for a property management company.
Your job is to analyze *tenant maintenance texts* and:

1. CLASSIFY the main issue into one of:
   - "plumbing": leaks, toilets, sinks, tubs, showers, pipes, drains, water lines, flooding, water pressure.
   - "hvac": heating, AC, furnace, thermostat, no heat, no cooling, vents.
   - "appliance": dishwasher, fridge, freezer, oven, stove, range, microwave, washing machine, dryer, garbage disposal.
   - "general": anything else (noise, neighbors, pests, questions, general messages).

2. DETERMINE if it is an EMERGENCY:
   Treat as emergency (emergency = true, riskLevel = "high") if any of these apply:
   - Active water leak (e.g. "water pouring", "ceiling leaking", "flooding", "pipe burst").
   - No heat in freezing or very cold conditions.
   - Electrical danger (sparks, burning smell from outlets, smoke).
   - Fire, gas smell, carbon monoxide.
   - Anything threatening health/safety.
   Otherwise, emergency = false. Choose riskLevel = "low" or "medium" based on severity.

3. DETECT missing information:
   - locationDetails: true if the message DOES NOT clearly say *where* the problem is (room / fixture / area).
   - accessWindow: true if the message DOES NOT include any indication when someone can enter (time frame).
   - severityDetails: true if the message DOES NOT describe severity ("small drip" vs "pouring", "stopped working" etc).
   - applianceOrFixture: true if relevant (appliance/plumbing) but the specific appliance/fixture is not clear.

4. ASK EXACTLY ONE BEST CLARIFICATION QUESTION if any missingFields are true and the message is not just a simple FYI.
   - The question should be short, natural, and specific to the most important missing field.
   - Example for leaks with no location: "Can you specify exactly where the leak is (e.g., under the kitchen sink, ceiling in the living room, etc.)?"
   - Example for no access window: "What time frame works best for someone to access the unit (morning, afternoon, or evening)?"
   If no clarification is needed, return needsClarification = false and clarificationQuestion = null.

Return ONLY valid JSON matching this TypeScript type, no extra explanation.
{
  "issueType": "plumbing" | "hvac" | "appliance" | "general",
  "emergency": boolean,
  "riskLevel": "low" | "medium" | "high",
  "needsClarification": boolean,
  "clarificationQuestion": string | null,
  "missingFields": {
    "locationDetails": boolean,
    "accessWindow": boolean,
    "severityDetails": boolean,
    "applianceOrFixture": boolean
  }
}
  Never ask for access time windows until physical diagnosis is complete.
Only ask for access time after:
	•	The issue type is clearly identified
	•	No more missing details
	•	No emergency is present
	•	Landlord has NOT been alerted as an emergency

Also never ask for access windows for:
	•	Minor drip
	•	Squeaky door
	•	Any message shorter than 6 words
	•	Any message that contains “ASAP”, “urgent”, “emergency” but DOES NOT describe real danger
`;

export async function triageMessage(
  message: string,
  apiKey: string
): Promise<TriageResult> {
  const client = new OpenAI({ apiKey });

  const completion = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Tenant message:\n"""${message}"""`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content?.trim() || "{}";

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error("Failed to parse triage JSON, raw content:", raw, err);
    // Fallback to safe default
    return {
      issueType: "general",
      emergency: false,
      riskLevel: "low",
      needsClarification: false,
      clarificationQuestion: null,
      missingFields: {
        locationDetails: false,
        accessWindow: false,
        severityDetails: false,
        applianceOrFixture: false,
      },
    };
  }

  // Defensive defaults to avoid blowing up smsInbound
  const result: TriageResult = {
    issueType:
      parsed.issueType === "plumbing" ||
      parsed.issueType === "hvac" ||
      parsed.issueType === "appliance"
        ? parsed.issueType
        : "general",
    emergency: Boolean(parsed.emergency),
    riskLevel:
      parsed.riskLevel === "medium" || parsed.riskLevel === "high"
        ? parsed.riskLevel
        : "low",
    needsClarification: Boolean(parsed.needsClarification),
    clarificationQuestion:
      typeof parsed.clarificationQuestion === "string"
        ? parsed.clarificationQuestion
        : null,
    missingFields: {
      locationDetails: Boolean(
        parsed?.missingFields?.locationDetails
      ),
      accessWindow: Boolean(parsed?.missingFields?.accessWindow),
      severityDetails: Boolean(
        parsed?.missingFields?.severityDetails
      ),
      applianceOrFixture: Boolean(
        parsed?.missingFields?.applianceOrFixture
      ),
    },
  };

  console.log("triageMessage result:", result);

  return result;
}
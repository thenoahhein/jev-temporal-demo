import { availableActions } from "../jev/questions";
import { banner, kv, section } from "../shared/console";
import { loadEnv } from "../shared/env";
import type { Action, IncidentState, JevJudgment, ReasoningAdvice } from "../shared/types";

loadEnv();

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function notifyHuman(input: {
  workflowId: string;
  action: Action;
  judgment: JevJudgment;
  reason: string;
}): Promise<void> {
  banner("WAITING FOR HUMAN APPROVAL");
  section(
    "PROPOSED ACTION",
    kv("action", input.action),
    kv("confidence", `${Math.round(input.judgment.next_action.confidence * 100)}%`),
    kv("reason", input.reason),
    "",
    `approve:  npm run approve -- ${input.workflowId}`,
    `reject:   npm run reject -- ${input.workflowId}`,
  );
}

export async function consultReasoningModel(input: {
  state: IncidentState;
  judgment: JevJudgment;
}): Promise<ReasoningAdvice> {
  const options = availableActions(input.state);
  let advice: ReasoningAdvice;

  if (process.env.OPENAI_API_KEY) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                'You are advising an incident-response agent. Reply with JSON {"recommended_action": <one of the allowed actions>, "rationale": <one sentence>}.',
            },
            {
              role: "user",
              content: JSON.stringify({
                state: input.state,
                jev_judgment: input.judgment,
                allowed_actions: options,
              }),
            },
          ],
        }),
      });
      const body = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? "{}") as {
        recommended_action?: Action;
        rationale?: string;
      };
      if (parsed.recommended_action && options.includes(parsed.recommended_action)) {
        advice = {
          model: "gpt-4o-mini",
          recommended_action: parsed.recommended_action,
          rationale: parsed.rationale ?? "no rationale given",
        };
      } else {
        advice = {
          model: "gpt-4o-mini",
          recommended_action: input.judgment.next_action.choice,
          rationale: `reasoning model suggested an unavailable action; keeping Jev's ${input.judgment.next_action.choice}`,
        };
      }
    } catch (err) {
      advice = {
        model: "gpt-4o-mini",
        recommended_action: input.judgment.next_action.choice,
        rationale: `reasoning model call failed (${err}); keeping Jev's ${input.judgment.next_action.choice}`,
      };
    }
  } else {
    await delay(1500);
    advice = {
      model: "mock-reasoning",
      recommended_action: input.judgment.next_action.choice,
      rationale: "mock reasoning model: agreed with Jev's leading option",
    };
  }

  section(
    "REASONING MODEL",
    kv("model", advice.model),
    kv("recommends", advice.recommended_action),
    kv("rationale", advice.rationale),
  );
  return advice;
}

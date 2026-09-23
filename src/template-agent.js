import OpenAI from "openai";

export async function reviseTemplateWithAi({ apiKey, model, instruction, html, subject, preheader, assets }) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  if (!instruction) throw new Error("instruction is required");
  const client = new OpenAI({ apiKey });
  const response = await client.responses.create({
    model: model || "gpt-5",
    instructions: "You edit production HTML email templates. Preserve table layout, inline CSS, Outlook compatibility and the footer unless explicitly asked to change it. Return only strict JSON with keys html, subject, preheader. Never include markdown fences.",
    input: `Instruction: ${instruction}\n\nCurrent subject: ${subject || ""}\nCurrent preheader: ${preheader || ""}\n\nCurrent HTML:\n${html}\n\nAvailable assets as public URLs:\n${assets.map((asset) => `${asset.name}: ${asset.publicUrl}`).join("\n")}`
  });
  let output;
  try { output = JSON.parse(response.output_text); } catch { throw new Error("AI response was not valid JSON"); }
  if (!output.html || typeof output.html !== "string") throw new Error("AI response did not include HTML");
  return { html: output.html, subject: String(output.subject || subject || ""), preheader: String(output.preheader || preheader || "") };
}

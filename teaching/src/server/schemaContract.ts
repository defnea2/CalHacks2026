/** A compact, lossless description of the JSON shapes sent to the planner.
 * Runtime Zod validation remains authoritative. Deriving this from the schema avoids
 * maintaining a second handwritten vocabulary and saves repeated JSON-schema boilerplate.
 */
export function schemaContract(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected a JSON schema object.");
  const schema = input as Record<string, unknown>;
  if ("const" in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map(value => JSON.stringify(value)).join("|");
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) return `(${alternatives.map(schemaContract).join("|")})`;
  if (schema.type === "null") return "null";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "string") {
    const length = schema.minLength !== undefined || schema.maxLength !== undefined
      ? `[${schema.minLength ?? 0}..${schema.maxLength ?? "∞"} chars]` : "";
    return `string${length}${schema.pattern ? ` matching ${JSON.stringify(schema.pattern)}` : ""}`;
  }
  if (schema.type === "number" || schema.type === "integer") {
    const bounds = schema.minimum !== undefined || schema.maximum !== undefined
      ? `[${schema.minimum ?? "-∞"}..${schema.maximum ?? "∞"}]` : "";
    return `${schema.type}${bounds}${schema.multipleOf ? ` step ${schema.multipleOf}` : ""}`;
  }
  if (schema.type === "array") return `Array<${schemaContract(schema.items)}>[${schema.minItems ?? 0}..${schema.maxItems ?? "∞"}]`;
  if (schema.type === "object") {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const properties = schema.properties as Record<string, unknown> | undefined;
    return `{${Object.entries(properties ?? {}).map(([key, value]) => `${key}${required.has(key) ? "" : "?"}:${schemaContract(value)}`).join(",")}}`;
  }
  throw new Error(`Unsupported planner schema shape: ${String(schema.type)}`);
}

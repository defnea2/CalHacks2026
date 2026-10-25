import { describe, expect, it } from "vitest";
import { z } from "zod";
import { StreamLessonSchema } from "./streamingLesson";
import { schemaContract } from "./schemaContract";

describe("compact planner contract", () => {
  it("preserves the visual vocabulary and bounds with much less prompt overhead", () => {
    const schema = z.toJSONSchema(StreamLessonSchema, { io: "input" });
    const contract = schemaContract(schema);
    expect(contract.length).toBeLessThan(JSON.stringify(schema).length * 0.5);
    expect(contract).toContain('kind:"parallelogram"');
    expect(contract).toContain('base:number[1..8] step 0.5');
    expect(contract).toContain('kind:"update"');
    expect(contract).toContain('operation:"sum"|"difference"|"product"|"quotient"');
    expect(contract).toContain('interactive?:boolean');
    expect(contract).toContain('[1..8]');
  });
  it("does not silently describe unknown schema shapes as unrestricted values", () => {
    expect(() => schemaContract({ $ref: "#/$defs/unknown" })).toThrow("Unsupported");
  });
});

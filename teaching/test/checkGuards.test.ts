import { describe, expect, it } from "vitest";
import { emptyCanvas, type CanvasState } from "../src/presentation/contracts";
import { assessResponse } from "../src/teaching/checks";
import { choiceProblem, homeworkRepeat, speakablePrompt, visibleAnswer } from "../src/teaching/checkGuards";
import type { TeachingCheck } from "../src/teaching/contracts";
import { answerResponse } from "../src/teaching/lessonFlow";
import { numbersIn, spokenValue } from "../src/teaching/numbers";

const choice = (prompt: string, labels: string[], correct: number): TeachingCheck => ({
  kind: "choice", prompt, options: labels.map((label, i) => ({ id: String.fromCharCode(97 + i), label })), correctOptionId: String.fromCharCode(97 + correct),
});
const number = (prompt: string, value: number): TeachingCheck => ({ kind: "number", prompt, rule: { operation: "value", value } });
function bars(...b: [number, number][]): CanvasState {
  const c = emptyCanvas();
  return { ...c, math: { visual: { kind: "bars", id: "math", title: "Pizza", bars: b.map(([shaded, parts], i) => ({ id: `b${i}`, label: `Pizza ${i}`, parts, shaded })) } } } as unknown as CanvasState;
}

describe("number reader", () => {
  it("reads digits, fractions, spoken fractions, decimals and bare denominators", () => {
    expect(numbersIn("Expand 2/3 so the bottom number is 12.")).toEqual([2, 3, 12]);
    expect(numbersIn("Which fraction is the same amount as two thirds?")).toEqual([2, 3]);
    expect(numbersIn("One half is the same amount as how many sixths?")).toEqual([1, 2, 6]);
    expect(numbersIn("Why is 1/4 + 2/4 not 3/8?")).toEqual([1, 4, 2, 4, 3, 8]);
    expect(numbersIn("Which is bigger, 0.3 or 0.25?")).toEqual([0.3, 0.25]);
    expect(numbersIn("zero point two five or a quarter, twenty one")).toEqual([0.25, 1, 4, 21]);
    expect(spokenValue("I think it's nine twelfths")).toEqual({ kind: "frac", num: 9, den: 12 });
    expect(spokenValue("9/12")).toEqual({ kind: "frac", num: 9, den: 12 });
    expect(spokenValue("nine over twelve")).toEqual({ kind: "frac", num: 9, den: 12 });
    expect(spokenValue("It's nine.")).toEqual({ kind: "num", value: 9 });
    expect(spokenValue("nine, no, eight")).toBeNull();
    expect(spokenValue("I don't know")).toBeNull();
  });
});

describe("homework guard (same numbers, not substring)", () => {
  const hw = "Expand 2/3 so the bottom number is 12.";
  it("rejects a paraphrase that uses every homework number (prompt + answer)", () => {
    expect(homeworkRepeat(choice("Which fraction is the same amount as two thirds?", ["4/6", "8/12", "3/4"], 1), hw)).toMatch(/same numbers as the learner's homework/);
    expect(homeworkRepeat(number("Two thirds is how many twelfths?", 8), hw)).toMatch(/homework/);
    expect(homeworkRepeat(number("Why is one quarter plus two quarters not three eighths? What is one quarter plus two quarters, in quarters?", 3), "Why is 1/4 + 2/4 not 3/8?")).toMatch(/homework/);
    expect(homeworkRepeat(choice("What is one quarter plus two quarters?", ["3/4", "3/8"], 0), "Why is 1/4 + 2/4 not 3/8?")).toMatch(/same fractions/);
    expect(homeworkRepeat(choice("Which is bigger, zero point three or zero point two five?", ["0.3", "0.25"], 0), "Which is bigger, 0.3 or 0.25? Explain why.")).toMatch(/homework/);
  });
  it("accepts a similar task with different numbers", () => {
    expect(homeworkRepeat(number("Expand three quarters so the bottom number is twelve. What is the top number?", 9), hw)).toBeNull();
    expect(homeworkRepeat(choice("One half is the same amount as how many sixths?", ["2 sixths", "3 sixths", "6 sixths"], 1), hw)).toBeNull();
    expect(homeworkRepeat(choice("Which is bigger, 0.4 or 0.35?", ["0.4", "0.35"], 0), "Which is bigger, 0.3 or 0.25? Explain why.")).toBeNull();
    expect(homeworkRepeat(number("What is 2 + 3?", 5), "Why do fractions work?")).toBeNull();
    expect(homeworkRepeat(choice("What is one fifth plus two fifths?", ["3/5", "3/10"], 0), "Why is 1/4 + 2/4 not 3/8?")).toBeNull();
  });
});

describe("choice tasks have exactly one correct option", () => {
  it("rejects a task with no, several or a mislabeled correct option", () => {
    expect(choiceProblem(choice("Which fraction is the same as three quarters?", ["6/12", "8/12", "10/12"], 1))).toMatch(/no correct option/);
    expect(choiceProblem(choice("Which fraction equals one half?", ["2/4", "3/6", "2/3"], 0))).toMatch(/2 correct options/);
    expect(choiceProblem(choice("Which is bigger?", ["0.3", "0.25"], 1))).toMatch(/correctOptionId names "0.25"/);
  });
  it("accepts consistent tasks and leaves unclear rules alone", () => {
    expect(choiceProblem(choice("One half of a pizza is the same amount as how many sixths?", ["2 sixths", "3 sixths", "6 sixths"], 1))).toBeNull();
    expect(choiceProblem(choice("One half is the same as how many sixths?", ["2", "3", "6"], 1))).toBeNull();
    expect(choiceProblem(choice("Which is smaller, 0.4 or 0.35?", ["0.4", "0.35"], 1))).toBeNull();
    expect(choiceProblem(choice("Which pizza has more cheese?", ["Pizza A", "Pizza B"], 0))).toBeNull();
    expect(choiceProblem(choice("How many more slices does Ben have?", ["1", "2"], 0))).toBeNull();
    expect(choiceProblem(number("What is 3 + 4?", 7))).toBeNull();
  });
});

describe("the task's answer is not visible", () => {
  it("rejects a check whose answer a bar shows exactly", () => {
    const shown = bars([1, 2], [3, 6]);
    expect(visibleAnswer(choice("One half of a pizza is the same amount as how many sixths?", ["2 sixths", "3 sixths", "6 sixths"], 1), shown)).toMatch(/already on the picture/);
    expect(visibleAnswer(number("One half is the same as how many sixths?", 3), shown)).toMatch(/already on the picture/);
    expect(visibleAnswer(number("Expand 2/3 so the bottom number is 12. What is the top number?", 8), bars([2, 3], [8, 12]))).toMatch(/already/);
    expect(visibleAnswer(choice("Which fraction is the same amount as two thirds?", ["4/6", "eight twelfths", "3/4"], 1), bars([8, 12]))).toMatch(/already/);
  });
  it("accepts an answer that is not drawn (equivalent pictures are the teaching point)", () => {
    expect(visibleAnswer(number("One third is the same as how many sixths?", 2), bars([1, 2], [3, 6]))).toBeNull();
    expect(visibleAnswer(number("Expand 3/4 so the bottom number is 12. What is the top number?", 9), bars([2, 3], [8, 12]))).toBeNull();
    expect(visibleAnswer(number("How many slices are shaded?", 3), bars([3, 6]))).toBeNull();
    expect(visibleAnswer(number("One half is how many sixths?", 3), emptyCanvas())).toBeNull();
    // Night rehearsal false positive: a bare count (2) never matches a drawn fraction (2 of 3).
    expect(visibleAnswer(number("If one third is cut into two smaller pieces, how many pieces does one third become in sixths? Say the number.", 2), bars([2, 3]))).toBeNull();
    expect(visibleAnswer(number("How many pieces of three are shaded? Say the number.", 2), bars([2, 3]))).toBeNull();
  });
});

describe("grading accepts equivalent answers", () => {
  const top = number("Expand three quarters so the bottom number is twelve. What is the top number?", 9);
  it("number check: the full fraction for the top number, a fraction of equal value, a number in a sentence", () => {
    expect(assessResponse(top, { kind: "answer", text: "9/12" }, emptyCanvas()).outcome).toBe("correct");
    expect(assessResponse(top, { kind: "answer", text: "nine twelfths" }, emptyCanvas()).outcome).toBe("correct");
    expect(assessResponse(top, { kind: "answer", text: "8/12" }, emptyCanvas()).outcome).toBe("incorrect");
    expect(assessResponse(top, { kind: "answer", text: "It's nine." }, emptyCanvas()).outcome).toBe("correct");
    expect(assessResponse(top, { kind: "answer", text: "9" }, emptyCanvas()).outcome).toBe("correct");
    expect(assessResponse(top, { kind: "answer", text: "I don't know" }, emptyCanvas()).outcome).toBe("unclear");
    const value = { kind: "number", prompt: "What is one quarter plus two quarters?", rule: { operation: "quotient", left: 3, right: 4 } } as TeachingCheck;
    expect(assessResponse(value, { kind: "answer", text: "three quarters" }, emptyCanvas()).outcome).toBe("correct");
    expect(assessResponse(value, { kind: "answer", text: "9/12" }, emptyCanvas()).outcome).toBe("correct");
    expect(assessResponse(value, { kind: "answer", text: "3/8" }, emptyCanvas()).outcome).toBe("unclear");
  });
  it("choice check: a spoken fraction picks the option of the same form, else the one of equal value", () => {
    const c = choice("Which is the same as six eighths?", ["3/4", "2/3", "4/5"], 0);
    expect(answerResponse(c, "nine twelfths")).toEqual({ kind: "choice", optionId: "a" });
    expect(answerResponse(c, "three quarters")).toEqual({ kind: "choice", optionId: "a" });
    expect(answerResponse(c, "two thirds")).toEqual({ kind: "choice", optionId: "b" });
    const twins = choice("Which is the same as two thirds?", ["4/6", "8/12", "3/4"], 1);
    expect(answerResponse(twins, "eight twelfths")).toEqual({ kind: "choice", optionId: "b" });
    expect(answerResponse(twins, "two thirds")).toEqual({ kind: "answer", text: "two thirds" });
    expect(answerResponse(twins, "the second one")).toEqual({ kind: "answer", text: "the second one" });
  });
});

describe("voice wording", () => {
  it("never tells a voice learner to type or tap", () => {
    expect(speakablePrompt("Type the top number.")).toBe("Say the top number.");
    expect(speakablePrompt("Tap on the bigger bar.")).toBe("Choose the bigger bar.");
    expect(speakablePrompt("What type of fraction is this?")).toBe("What type of fraction is this?");
  });
});

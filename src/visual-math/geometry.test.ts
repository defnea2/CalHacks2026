import { expect, it } from "vitest";
import {
  connectionPath,
  diagramLayout,
  reorderObject,
  tickValues,
  valueFromPosition,
} from "./geometry";

it("moves an object without duplicating IDs or modifying the original order", () => {
  const order = ["a", "b", "c", "d"];
  expect(reorderObject(order, "a", "c")).toEqual(["b", "c", "a", "d"]);
  expect(reorderObject(order, "missing", "a")).toEqual(order);
  expect(order).toEqual(["a", "b", "c", "d"]);
});
it("maps pointer positions to bounded values and preserves fractional ranges", () => {
  expect(valueFromPosition(180, 100, 100, 0, 10)).toBe(8);
  expect(valueFromPosition(0, 100, 100, 0, 10)).toBe(0);
  expect(valueFromPosition(500, 100, 100, 0, 10)).toBe(10);
  expect(valueFromPosition(150, 100, 100, 0, 1)).toBe(0.5);
  expect(() => valueFromPosition(0, 0, 0, 0, 10)).toThrow();
});
it("keeps exact endpoints on bounded tick sets", () => {
  expect(tickValues(0, 1)).toEqual([0, 1]);
  const ticks = tickValues(-100, 100);
  expect(ticks).toHaveLength(11);
  expect(ticks[0]).toBe(-100);
  expect(ticks.at(-1)).toBe(100);
});
it("lays out nodes by accepted order and terminates arrows outside the cards", () => {
  const layout = diagramLayout(["a", "b", "c", "d"], 2);
  expect(layout.positions.a).toEqual({ x: 250, y: 105 });
  expect(layout.positions.c).toEqual({ x: 250, y: 280 });
  expect(connectionPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 10)).toBe(
    "M 10 0 L 90 0",
  );
  expect(connectionPath({ x: 0, y: 0 }, { x: 0, y: 100 }, 10, 10)).toBe(
    "M 0 10 L 0 90",
  );
});

import { tool } from "@langchain/core/tools";
import { all, create } from "mathjs";
import { z } from "zod";

const math = create(all ?? {}, {});
const evaluate = math.evaluate.bind(math);
const format = math.format.bind(math);

// Lock down functions that can mutate the instance or parse arbitrary code (mathjs security guidance).
const disabled = (name: string) => () => {
  throw new Error(`Function ${name} is disabled`);
};
math.import(
  {
    import: disabled("import"),
    createUnit: disabled("createUnit"),
    reviver: disabled("reviver"),
    evaluate: disabled("evaluate"),
    parse: disabled("parse"),
    simplify: disabled("simplify"),
    derivative: disabled("derivative"),
    resolve: disabled("resolve"),
  },
  { override: true },
);

export function calculate(expression: string): string {
  if (expression.length > 500) throw new Error("Expression too long (max 500 characters)");
  return format(evaluate(expression), { precision: 14 });
}

export function createCalculatorTool() {
  return tool(
    async ({ expression }) => {
      try {
        return calculate(expression);
      } catch (error) {
        return `Error: ${(error as Error).message}`;
      }
    },
    {
      name: "calculator",
      description:
        "Evaluate a math expression exactly (arithmetic, percentages, powers, log, units like '5 GB to MB'). " +
        "Use it for every multi-step calculation.",
      schema: z.object({ expression: z.string().describe("e.g. '(1200 * 1.07^3) / 12' or '50e6 * 1536 * 4 bytes to GB'") }),
    },
  );
}

import { z } from "zod";

export const AgentModelSchema = z.union([
  z.string(),
  z
    .object({
      primary: z.string().optional(),
      fallbacks: z.array(z.string()).optional(),
      perModelFallbacks: z.record(z.string(), z.array(z.string())).optional(),
    })
    .strict(),
]);

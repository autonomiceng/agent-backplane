// Release requires an explicit assertion that the source primary has stopped.
import { t } from "elysia";
export const releaseRestoreInput = t.Object({ epoch: t.String({ format: "uuid" }), sourceFenced: t.Literal(true) }, { additionalProperties: false });
export const releaseRestoreResponse = t.Object({ epoch: t.String(), done: t.Boolean(), processed: t.Integer() });

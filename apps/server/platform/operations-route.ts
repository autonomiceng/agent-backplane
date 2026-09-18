// Operator authentication happens before the shared, bounded gather.
import type { Enrollment } from "../auth/enrollment.ts";
import { createHash, timingSafeEqual } from "node:crypto";
import { Elysia, t } from "elysia";
import { poolSnapshot, type Pool } from "./pool.ts";
import { admissionSnapshot, type PrincipalAdmission } from "./principal-admission.ts";
import { streamSnapshot } from "../events/stream-admission.ts";
import { decideOperations, operationsSchema, readOperationsConfig, type OperationsConfig } from "./operations.ts";
import { operationsProbe } from "./operations-probe.ts";
import { operationsMetrics } from "./operations-metrics.ts";
export function operationsRoute(pool: Pool, config: OperationsConfig = readOperationsConfig({}), admission: PrincipalAdmission, streams: Map<string,number>, enrollment?: Enrollment) {
  const probe=operationsProbe(pool,config,enrollment), hash=(s:string)=>createHash("sha256").update(s).digest();
  const expected=hash(config.token ?? "");
  const error=t.Object({ error:t.Union([t.Literal("operations_disabled"),t.Literal("operations_unauthorized")]) });
  const response=async (request:Request,metrics:boolean)=>{
    const headers={ "cache-control":"no-store" };
    if (!config.token) return Response.json({error:"operations_disabled"},{status:503,headers});
    const supplied=request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1] ?? "";
    if (!timingSafeEqual(expected,hash(supplied))) return Response.json({error:"operations_unauthorized"},{status:401,headers});
    const sample=await probe(), elapsed=(performance.now()-sample.started)/1000;
    const now=Date.parse(sample.database?.observedAt ?? sample.snapshot?.observedAt ?? "")+(performance.now()-sample.clockAt);
    const result=decideOperations({...sample,elapsed,pool:poolSnapshot(pool),admission:admissionSnapshot(admission),streams:streamSnapshot(streams)},now,config);
    return metrics ? new Response(operationsMetrics(result),{headers:{...headers,"content-type":"text/plain; version=0.0.4; charset=utf-8"}})
      : Response.json(result.document,{status:result.document.status !== "ok" ? 503 : 200,headers});
  };
  const detail={ "x-backplane-auth":"operator","x-backplane-run":"none",tags:["operations"] };
  return new Elysia({name:"operations"})
    .get("/health/operations",({request})=>response(request,false),{response:{200:operationsSchema,401:error,503:t.Union([operationsSchema,error])},detail:{...detail,operationId:"healthOperations"}})
    .get("/metrics",({request})=>response(request,true),{response:{401:error,503:error},detail:{...detail,operationId:"operationsMetrics",responses:{200:{description:"Prometheus gauges",content:{"text/plain":{schema:{type:"string"}}}}}}});
}

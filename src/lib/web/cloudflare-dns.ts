import { isIP } from "node:net";
import { Agent, EnvHttpProxyAgent, fetch } from "undici";
import { z } from "zod";
import { readLimitedJson } from "@/lib/models/catalog-read";
import { outboundProxyOptions, proxyTunnelClient } from "@/lib/server/proxy";

const resolverUrl = "https://cloudflare-dns.com/dns-query";
const dnsAnswer = z.object({
  Status: z.literal(0),
  TC: z.literal(false),
  Question: z.tuple([z.object({ name: z.string(), type: z.number() })]),
  Answer: z.array(z.object({ type: z.number(), data: z.string() })).optional(),
});

export async function resolveCloudflareAddresses(host: string, signal: AbortSignal) {
  const options = outboundProxyOptions();
  const finished = new AbortController();
  const deadline = AbortSignal.any([signal, finished.signal, AbortSignal.timeout(5000)]);
  const dispatcher = options ? new EnvHttpProxyAgent({ ...options, clientFactory: proxyTunnelClient(deadline) }) : new Agent();
  try {
    const answers = await Promise.all(([["A", 1, 4], ["AAAA", 28, 6]] as const).map(async ([type, record, family]) => {
      const url = new URL(resolverUrl);
      url.searchParams.set("name", host);
      url.searchParams.set("type", type);
      const response = await fetch(url, { dispatcher, signal: deadline, redirect: "error", headers: { accept: "application/dns-json" } });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("DNS query failed");
      }
      const { Question: [question], Answer = [] } = dnsAnswer.parse(await readLimitedJson(response as unknown as Response, 32 * 1024));
      if (question.type !== record || question.name.replace(/\.$/, "").toLowerCase() !== host.replace(/\.$/, "").toLowerCase()) {
        throw new Error("DNS response did not match the query");
      }
      return Answer.filter(answer => answer.type === record).map(({ data: address }) => {
        if (isIP(address) !== family) throw new Error("Invalid DNS address");
        return { address, family };
      });
    }));
    return answers.flat();
  } finally {
    finished.abort();
    await dispatcher.destroy().catch(() => {});
  }
}

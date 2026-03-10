import { TavilyClient } from "tavily";

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

function formatResult(result) {
  const lines = [];
  const answer = typeof result?.answer === "string" ? result.answer.trim() : "";
  if (answer) lines.push(`Answer: ${answer}`);

  const entries = Array.isArray(result?.results) ? result.results : [];
  if (!entries.length) {
    lines.push("No Tavily results.");
    return lines.join("\n\n");
  }

  lines.push("Sources:");
  entries.forEach((entry, index) => {
    const title =
      typeof entry?.title === "string" && entry.title.trim()
        ? entry.title.trim()
        : `Result ${index + 1}`;
    const url = typeof entry?.url === "string" ? entry.url.trim() : "";
    const content = typeof entry?.content === "string" ? entry.content.trim() : "";
    lines.push(`${index + 1}. ${title}`);
    if (url) lines.push(`   ${url}`);
    if (content) lines.push(`   ${content}`);
  });

  return lines.join("\n");
}

const plugin = {
  id: "tavily-search",
  name: "Tavily Search",
  description: "Adds a Tavily-backed web search tool for GPT sessions.",
  register(api) {
    api.registerTool(
      {
        name: "tavily_search",
        description:
          "Search the web with Tavily and return concise source-backed results. Use this instead of core web_search in GPT sessions.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", minLength: 1 },
            maxResults: { type: "integer", minimum: 1, maximum: 10 },
            topic: { type: "string" },
            searchDepth: {
              type: "string",
              enum: ["basic", "advanced"],
            },
            includeAnswer: { type: "boolean" },
            includeDomains: {
              type: "array",
              items: { type: "string" },
            },
            excludeDomains: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["query"],
        },
        async execute(_id, params) {
          try {
            const apiKey = (process.env.TAVILY_API_KEY || "").trim();
            if (!apiKey) {
              return {
                content: [
                  {
                    type: "text",
                    text: "TAVILY_API_KEY is not configured in the Gateway environment.",
                  },
                ],
              };
            }

            const tavily = new TavilyClient({ apiKey });
            const request = {
              query: params.query,
              max_results: params.maxResults ?? 5,
              search_depth: params.searchDepth ?? "advanced",
              topic:
                typeof params.topic === "string" && params.topic.trim()
                  ? params.topic.trim()
                  : "general",
              include_answer: params.includeAnswer !== false,
            };

            const includeDomains = cleanList(params.includeDomains);
            if (includeDomains.length) request.include_domains = includeDomains;

            const excludeDomains = cleanList(params.excludeDomains);
            if (excludeDomains.length) request.exclude_domains = excludeDomains;

            const result = await tavily.search(request);
            return {
              content: [
                {
                  type: "text",
                  text: formatResult(result),
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Tavily search failed: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }
        },
      },
      { optional: true },
    );
  },
};

export default plugin;

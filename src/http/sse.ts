/** Token usage as reported by OpenAI-compatible APIs. */
export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/**
 * Watches an SSE stream for a `usage` object (sent in the last chunk when the client
 * asks for `stream_options.include_usage`). Only lines mentioning "usage" are parsed.
 */
export class UsageSniffer {
  usage?: Usage;
  private buffer = '';
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:') || !line.includes('"usage"')) continue;
      try {
        const usage = (JSON.parse(line.slice(5)) as { usage?: Usage | null }).usage;
        if (usage) this.usage = usage;
      } catch {
        // Not JSON (e.g. `data: [DONE]`) or a partial line; ignore.
      }
    }
  }
}

export function extractUsage(body: string): Usage | undefined {
  try {
    return (JSON.parse(body) as { usage?: Usage }).usage ?? undefined;
  } catch {
    return undefined;
  }
}

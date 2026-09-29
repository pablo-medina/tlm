import type { FastifyReply } from 'fastify';

export interface OpenAIErrorBody {
  error: { message: string; type: string; param: string | null; code: string | null };
}

export function openAIError(
  message: string,
  type: string,
  code: string | null = null,
  param: string | null = null,
): OpenAIErrorBody {
  return { error: { message, type, param, code } };
}

export function sendError(
  reply: FastifyReply,
  status: number,
  message: string,
  type: string,
  code: string | null = null,
  param: string | null = null,
): FastifyReply {
  return reply
    .code(status)
    .type('application/json')
    .send(openAIError(message, type, code, param));
}

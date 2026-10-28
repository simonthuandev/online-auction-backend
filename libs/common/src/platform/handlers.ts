import { Injectable } from '@nestjs/common';
import type { AuthRequest } from './http.js';
export type HttpBusinessHandler = (request: AuthRequest) => Promise<unknown>;
@Injectable()
export class HttpHandlers {
  private readonly handlers = new Map<string, HttpBusinessHandler>();
  register(operationId: string, handler: HttpBusinessHandler) {
    if (this.handlers.has(operationId))
      throw Error(`Duplicate HTTP handler: ${operationId}`);
    this.handlers.set(operationId, handler);
  }
  get(operationId: string) {
    return this.handlers.get(operationId);
  }
}

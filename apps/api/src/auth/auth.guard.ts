import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from './public.decorator.js';

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.get<boolean>(
      IS_PUBLIC_KEY,
      context.getHandler(),
    );
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers['authorization'];

    if (!authHeader) {
      this.logger.warn(`🔒 Auth failed: missing Authorization header - ${request.method} ${request.url}`);
      throw new UnauthorizedException('Missing Authorization header');
    }

    const [scheme, token] = authHeader.split(' ');

    if (scheme !== 'Bearer' || !token) {
      this.logger.warn(`🔒 Auth failed: invalid format - ${request.method} ${request.url}`);
      throw new UnauthorizedException('Invalid Authorization header format. Expected: Bearer <token>');
    }

    const expectedToken = process.env.BACKEND_ADMIN_TOKEN;

    if (!expectedToken) {
      this.logger.error('🔒 BACKEND_ADMIN_TOKEN is not configured on the server');
      throw new UnauthorizedException('BACKEND_ADMIN_TOKEN is not configured on the server');
    }

    if (token !== expectedToken) {
      this.logger.warn(`🔒 Auth failed: invalid token - ${request.method} ${request.url}`);
      throw new UnauthorizedException('Invalid token');
    }

    this.logger.debug(`🔓 Auth success: ${request.method} ${request.url}`);
    return true;
  }
}

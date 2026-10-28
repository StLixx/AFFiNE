import { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server, Socket } from 'socket.io';

import { Config } from '../config';
import {
  buildCorsAllowedOrigins,
  CORS_ALLOWED_HEADERS,
  CORS_ALLOWED_METHODS,
  corsOriginCallback,
} from '../cors';
import { AuthenticationRequired } from '../error';
import { URLHelper } from '../helpers';
import { AFFiNELogger } from '../logger';
import { SocketIoRedis } from '../redis';
import { WEBSOCKET_OPTIONS } from './options';

export class SocketIoAdapter extends IoAdapter {
  constructor(private readonly app: INestApplication) {
    super(app);
  }

  override createIOServer(port: number, options?: any): Server {
    const logger = this.app.get(AFFiNELogger);
    const config = this.app.get(WEBSOCKET_OPTIONS) as Config['websocket'] & {
      canActivate: (socket: Socket) => Promise<boolean>;
      revalidateSession?: (socket: Socket) => Promise<unknown>;
    };
    const url = this.app.get(URLHelper);
    const allowedOrigins = buildCorsAllowedOrigins(url);

    const server: Server = super.createIOServer(port, {
      ...config,
      ...options,
      cors: {
        origin: (
          origin: string | undefined,
          callback: (error: Error | null, allow?: boolean) => void
        ) => {
          corsOriginCallback(
            origin,
            allowedOrigins,
            blockedOrigin =>
              logger.warn(
                `Blocked WebSocket CORS request from origin: ${blockedOrigin}`
              ),
            callback
          );
        },
        credentials: true,
        methods: CORS_ALLOWED_METHODS,
        allowedHeaders: CORS_ALLOWED_HEADERS,
      },
    });

    if (config.canActivate) {
      server.use((socket, next) => {
        config
          .canActivate(socket)
          .then(pass => {
            if (pass) {
              const revalidateSession = config.revalidateSession;
              if (revalidateSession) {
                socket.use((packet, done) => {
                  revalidateSession(socket).then(
                    () => done(),
                    () => {
                      const error = new AuthenticationRequired();
                      const rejection = {
                        error: {
                          status: error.status,
                          code: error.name.toUpperCase(),
                          type: error.type.toUpperCase(),
                          name: error.name.toUpperCase(),
                          message: error.message,
                        },
                      };
                      const acknowledge = packet[packet.length - 1];
                      if (typeof acknowledge === 'function') {
                        acknowledge(rejection);
                      } else {
                        socket.emit('error', rejection);
                      }
                      done(error);
                    }
                  );
                });
              }
              next();
            } else {
              throw new AuthenticationRequired();
            }
          })
          .catch(e => {
            next(e);
          });
      });
    }

    const pubClient = this.app.get(SocketIoRedis);
    const subClient = pubClient.duplicate();

    server.adapter(createAdapter(pubClient, subClient));
    const close = server.close;

    server.close = async fn => {
      await close.call(server, fn);
      // NOTE(@forehalo):
      //   the lifecycle of duplicated redis client will not be controlled by nestjs lifecycle
      //   we've got to manually disconnect it
      subClient.disconnect();
    };

    return server;
  }
}

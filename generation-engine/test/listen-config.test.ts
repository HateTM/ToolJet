import { resolveListenConfig } from '../src/listen-config';

describe('resolveListenConfig', () => {
  it('defaults to 0.0.0.0 so the service is reachable over a docker network, not just loopback', () => {
    const config = resolveListenConfig({});

    expect(config.host).toBe('0.0.0.0');
  });

  it('defaults to port 3100', () => {
    const config = resolveListenConfig({});

    expect(config.port).toBe(3100);
  });

  it('honours HOST and PORT env overrides', () => {
    const config = resolveListenConfig({ HOST: '127.0.0.1', PORT: '4000' });

    expect(config).toEqual({ host: '127.0.0.1', port: 4000 });
  });
});

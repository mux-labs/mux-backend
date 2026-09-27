import * as fs from 'fs';
import * as path from 'path';

describe('Dockerfile non-root readiness', () => {
  const repoRoot = path.join(__dirname, '..');

  let dockerfile: string;
  let entrypoint: string;
  let dockerCompose: string;

  beforeAll(() => {
    dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
    entrypoint = fs.readFileSync(path.join(repoRoot, 'docker-entrypoint.sh'), 'utf8');
    dockerCompose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
  });

  describe('Dockerfile', () => {
    it('should create a non-root user', () => {
      expect(dockerfile).toMatch(/adduser.*mux/);
    });

    it('should switch to the non-root user before ENTRYPOINT/CMD', () => {
      // USER must appear after the copy of entrypoint and before ENTRYPOINT/CMD
      const userLineIndex = dockerfile.split('\n').findIndex((l) => l.trim().startsWith('USER '));
      const entrypointIndex = dockerfile.split('\n').findIndex((l) => l.includes('ENTRYPOINT'));
      const cmdIndex = dockerfile.split('\n').findIndex((l) => l.includes('CMD'));

      expect(userLineIndex).toBeGreaterThan(-1);
      expect(userLineIndex).toBeLessThan(entrypointIndex);
      expect(userLineIndex).toBeLessThan(cmdIndex);
    });

    it('should not run the application as root (USER mux or USER 1001)', () => {
      expect(dockerfile).toMatch(/USER\s+mux|USER\s+1001/);
    });

    it('should set execute permission on the entrypoint script', () => {
      expect(dockerfile).toContain('chmod +x');
    });

    it('should chown the entrypoint script to the non-root user', () => {
      expect(dockerfile).toContain('chown mux:mux');
    });

    it('should not include build tools or source code in the runner stage', () => {
      // The runner stage should not copy node_modules/.cache or build artifacts
      // that are only needed during compilation
      const runnerStage = dockerfile.split('FROM node:22-alpine AS runner').pop();
      expect(runnerStage).toBeDefined();
      // Should not copy the full source tree
      expect(runnerStage).not.toContain('COPY . .');
    });
  });

  describe('docker-entrypoint.sh', () => {
    it('should be executable', () => {
      const stat = fs.statSync(path.join(repoRoot, 'docker-entrypoint.sh'));
      expect(stat.mode & 0o111).toBeTruthy();
    });

    it('should use set -e for fail-closed behavior', () => {
      expect(entrypoint).toContain('set -e');
    });

    it('should run prisma migrate deploy before starting the app', () => {
      expect(entrypoint).toContain('prisma migrate deploy');
    });

    it('should exec the CMD so the app replaces the entrypoint process', () => {
      expect(entrypoint).toContain('exec "$@"');
    });

    it('should not require root privileges', () => {
      // The entrypoint should not contain any commands that require root
      // (e.g., no chown, no systemctl, no ip/iptables commands)
      const rootOnlyCommands = ['systemctl', 'ip ', 'iptables', 'chown ', 'chmod 777'];
      for (const cmd of rootOnlyCommands) {
        expect(entrypoint).not.toContain(cmd);
      }
    });
  });

  describe('docker-compose.yml', () => {
    it('should run the api service as the non-root mux user', () => {
      expect(dockerCompose).toContain('user: "1001:1001"');
    });

    it('should set no-new-privileges for defense-in-depth', () => {
      expect(dockerCompose).toContain('no-new-privileges:true');
    });

    it('should not expose privileged ports as root', () => {
      // The api service should not map privileged ports (< 1024)
      const apiServiceMatch = dockerCompose.match(/api:[\s\S]*?(?=\n  \w|$)/);
      if (apiServiceMatch) {
        const portsMatch = apiServiceMatch[0].match(/ports:\s*\n\s*-\s*'(\d+):/);
        if (portsMatch) {
          const port = parseInt(portsMatch[1], 10);
          expect(port).toBeGreaterThanOrEqual(1024);
        }
      }
    });
  });

  describe('cross-links and documentation', () => {
    it('README.md should document container hardening', () => {
      const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
      expect(readme).toContain('Container Hardening');
      expect(readme).toContain('non-root');
    });

    it('SECURITY.md should document container hardening invariants', () => {
      const security = fs.readFileSync(path.join(repoRoot, 'SECURITY.md'), 'utf8');
      expect(security).toContain('Container Hardening');
      expect(security).toContain('non-root');
    });

    it('DOCKER-COMPOSE-LOCAL.md should mention the non-root user', () => {
      const docs = fs.readFileSync(path.join(repoRoot, 'docs/DOCKER-COMPOSE-LOCAL.md'), 'utf8');
      expect(docs).toContain('non-root');
      expect(docs).toContain('mux');
    });
  });
});

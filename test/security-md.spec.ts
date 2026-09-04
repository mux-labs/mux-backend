import * as fs from 'fs';
import * as path from 'path';

describe('SECURITY.md', () => {
  let securityContent: string;

  beforeAll(() => {
    const securityPath = path.join(__dirname, '..', 'SECURITY.md');
    securityContent = fs.readFileSync(securityPath, 'utf8');
  });

  it('should exist', () => {
    expect(securityContent).toBeDefined();
    expect(securityContent.length).toBeGreaterThan(0);
  });

  it('should define a private vulnerability disclosure process', () => {
    expect(securityContent).toContain('private');
    expect(securityContent).toContain('security@mux.com');
    expect(securityContent).toContain('DO NOT file public GitHub issues');
  });

  it('should specify response SLA', () => {
    expect(securityContent).toContain('Response SLA');
    expect(securityContent).toContain('Critical');
    expect(securityContent).toContain('High');
    expect(securityContent).toContain('Medium');
    expect(securityContent).toContain('Low');
  });

  it('should define in-scope vulnerability categories', () => {
    expect(securityContent).toContain('Wallet Encryption & Key Management');
    expect(securityContent).toContain('Custody & Transaction Signing');
    expect(securityContent).toContain('Internal Endpoint Access Control');
    expect(securityContent).toContain('API Key & Authentication');
    expect(securityContent).toContain('Data Integrity & Confidentiality');
  });

  it('should specify safe harbor for researchers', () => {
    expect(securityContent).toContain('Safe Harbor');
  });

  it('should document production security requirements', () => {
    expect(securityContent).toContain('Production Security Requirements');
    expect(securityContent).toContain('WALLET_ENCRYPTION_KEY');
    expect(securityContent).toContain('CRON_SECRET');
    expect(securityContent).toContain('Fail-Closed');
  });

  it('should mention Stellar custody concerns', () => {
    expect(securityContent).toContain('Stellar');
    expect(securityContent).toContain('custody');
    expect(securityContent).toContain('private');
  });

  it('should advise against logging secrets', () => {
    expect(securityContent).toContain('Never log');
    expect(securityContent).toContain('WALLET_ENCRYPTION_KEY');
  });

  it('should define a responsible disclosure timeline', () => {
    expect(securityContent).toContain('Responsible Disclosure');
    expect(securityContent).toContain('90 days');
  });

  it('should prevent public GitHub issues for custody/relayer vulnerabilities', () => {
    expect(securityContent).toContain('custody');
    expect(securityContent).toContain('relayer');
    expect(securityContent).toContain('private');
  });

  it('should include security contacts', () => {
    expect(securityContent).toContain('Security Contacts');
    expect(securityContent).toContain('security@mux.com');
  });
});

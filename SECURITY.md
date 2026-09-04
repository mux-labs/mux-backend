# Security Policy

## Vulnerability Disclosure

Mux Backend is a custody and blockchain relay platform that manages private keys, signs transactions, and handles sensitive financial operations. **Vulnerabilities must be reported privately** to prevent exploitation or public disclosure of attack vectors.

### Reporting a Vulnerability

**DO NOT file public GitHub issues for security vulnerabilities.**

Instead, report security vulnerabilities privately via email:

**📧 Email:** [security@mux.com](mailto:security@mux.com)

Include the following in your report:
- Description of the vulnerability and its impact
- Steps to reproduce (if applicable)
- Affected components or endpoints
- Suggested fix (if you have one)
- Your name and contact information (optional)

### Response SLA

We commit to the following security response times:

| Severity | Initial Response | Resolution Target |
|----------|------------------|-------------------|
| **Critical** (e.g., key leakage, unauthorized transaction signing, custody breach) | 4 hours | 48 hours |
| **High** (e.g., auth bypass, unencrypted keys at rest, privilege escalation) | 24 hours | 7 days |
| **Medium** (e.g., timing attacks, rate limit bypass, data exposure) | 48 hours | 14 days |
| **Low** (e.g., info disclosure, best practice violations) | 1 week | 30 days |

### Scope: Critical Security Domains

The following are considered **in scope** for private disclosure and will be treated as critical:

1. **Wallet Encryption & Key Management**
   - Private key exposure at any point
   - Unencrypted key storage or transmission
   - `WALLET_ENCRYPTION_KEY` compromise
   - Key derivation or seed exposure

2. **Custody & Transaction Signing**
   - Unauthorized transaction signature generation
   - Double-signing vulnerabilities
   - Sponsored transaction authorization bypass
   - Relayer funding account compromise

3. **Internal Endpoint Access Control**
   - Authentication bypass on cron/internal endpoints
   - Missing or insufficient `CRON_SECRET` validation
   - Unauthorized access to transaction polling or relayer funding
   - Background job manipulation

4. **API Key & Authentication**
   - API key validation bypass
   - Token reuse or replay attacks
   - Session hijacking
   - Privilege escalation to other projects/tenants

5. **Data Integrity & Confidentiality**
   - Unencrypted sensitive data (keys, seeds, private data)
   - Cross-tenant data exposure
   - Audit log tampering
   - Unauthorized access to wallet balances or transaction history

### Scope: Out of Scope

The following are typically **out of scope** (though context matters):

- Denial of service (unless critical to availability)
- Brute force attacks on rate-limited endpoints
- Social engineering or phishing
- Third-party dependency vulnerabilities (report to upstream maintainers)
- XSS in OpenAPI documentation (frontend concerns)
- General best practice violations without security impact

### Disclosure Timeline

**Responsible Disclosure Window:** 90 days from confirmation

1. **Day 0:** Vulnerability reported
2. **Day 0-4:** Initial assessment and response (critical issues)
3. **Day 1-7:** Patch development and testing
4. **Day 7-14:** Release to production (staged rollout if needed)
5. **Day 30:** Public disclosure via advisory (after fix is widely deployed)
6. **Day 90:** Full public disclosure if unresolved (rare)

### What to Expect

1. **Confirmation:** We'll confirm receipt and provide a tracking reference
2. **Assessment:** We'll evaluate severity and impact
3. **Collaboration:** We may ask follow-up questions or request proof-of-concept code
4. **Updates:** We'll provide regular status updates
5. **Credit:** With your permission, we'll credit the reporter in the security advisory

### Code of Conduct

- **Do not exploit** the vulnerability beyond proof-of-concept
- **Do not access** data beyond what's necessary to demonstrate the issue
- **Do not share** the vulnerability with others until we've publicly disclosed
- **Do not demand** payment or threaten disclosure (extortion is illegal)

### Safe Harbor

We commit to not taking legal action against researchers who:
- Report vulnerabilities in good faith
- Follow responsible disclosure practices
- Avoid privacy violations or data exfiltration
- Do not exploit the vulnerability for personal gain

---

## Production Security Requirements

To safely custody Stellar keys, relay sponsored transactions, and expose a production `/v1` API to the dashboard/SDK, the following controls **must** be in place:

### Required Environment Variables (Production)

- ✅ `WALLET_ENCRYPTION_KEY` — AES-256-GCM key for encrypting private keys at rest
- ✅ `CRON_SECRET` — Shared secret for internal cron/background job endpoints
- ✅ `MAINTENANCE_ADMIN_SECRET` — Secret for maintenance mode authentication
- ✅ `AUTH_PROVIDER` — Identity provider (CLERK, BETTER_AUTH, etc.)
- ✅ `DATABASE_URL` — PostgreSQL connection string (must use SSL in production)
- ✅ `HORIZON_URL` — Stellar Horizon endpoint URL
- ✅ `STELLAR_NETWORK_PASSPHRASE` — Mainnet or Testnet passphrase

### Deployment Checklist

Before deploying to production:

- [ ] All secrets are stored in secure environment (not hardcoded, not in .env file)
- [ ] `WALLET_ENCRYPTION_KEY` is randomly generated and never logged
- [ ] `CRON_SECRET` is randomly generated (e.g., `openssl rand -hex 32`)
- [ ] `MAINTENANCE_ADMIN_SECRET` is set and validated at startup
- [ ] Database uses TLS/SSL for all connections
- [ ] API runs behind reverse proxy with rate limiting and WAF
- [ ] Request logging does not include API keys, secrets, or private keys
- [ ] Audit logs are enabled and immutable
- [ ] Monitoring and alerting are configured for security events
- [ ] Incident response plan is documented

### Runtime Guardrails

- **Fail-Closed:** Missing critical secrets (WALLET_ENCRYPTION_KEY, CRON_SECRET) cause startup failure, not silent degradation
- **Logging:** Never log `WALLET_ENCRYPTION_KEY`, API keys, seeds, or secret tokens
- **Error Messages:** Do not expose internal paths, stack traces, or secrets in error responses
- **Request IDs:** All logs include request IDs for traceability and forensics
- **Rate Limiting:** API key rate limits prevent brute force and abuse
- **Tenant Scoping:** Data is isolated per project/tenant; cross-tenant access is impossible

---

## Security Contacts

- **Security Email:** [security@mux.com](mailto:security@mux.com)
- **PGP Key:** Available at [mux.com/security.pgp](https://mux.com/security.pgp) (coming soon)
- **Response Time:** See SLA section above

---

## References

- [OWASP: Vulnerability Disclosure Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Vulnerability_Disclosure_Cheat_Sheet.html)
- [Stellar Security Policy](https://developers.stellar.org/docs/learn/security)
- [NestJS Security Checklist](https://docs.nestjs.com/security/helmet)

---

## Version History

| Date | Version | Changes |
|------|---------|---------|
| 2026-08-30 | 1.0 | Initial security policy; private disclosure process and SLA |

---

**Last Updated:** 2026-08-30  
**Status:** Active

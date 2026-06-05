import 'dotenv/config'
import express, { Request, Response } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import crypto from 'crypto'
import axios from 'axios'

const PORT = parseInt(process.env.PORT || '3000')
const REVIEWER_KEY = process.env.REVIEWER_KEY || ''
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://claude.ai,https://api.anthropic.com').split(',')
const JWT_SECRET = process.env.JWT_SECRET ||
  crypto.createHash('sha256').update('clearrates-' + (REVIEWER_KEY || 'default')).digest('hex')
const BASE_URL = (process.env.BASE_URL || 'https://clearrates.onrender.com').replace(/\/$/, '')
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || ''
const RESEND_API_KEY = process.env.RESEND_API_KEY || ''

// ── Rates database ────────────────────────────────────────────────────────────
// Source: GOV.UK (Open Government Licence v3.0) — updated manually each April

const DB = {
  current_tax_year: '2026-27',
  effective_from: '2026-04-06',
  effective_to: '2027-04-05',
  source: 'GOV.UK (Open Government Licence v3.0)',
  last_updated: '2026-04-06',

  nmw: {
    label: 'National Minimum Wage / National Living Wage',
    effective_from: '2026-04-01',
    note: 'NMW rates change on 1 April each year',
    rates: {
      nlw_21_plus: { label: 'National Living Wage (aged 21 and over)', rate: 12.71, unit: '£/hour' },
      rate_18_20:  { label: 'Aged 18 to 20',                           rate: 10.85, unit: '£/hour' },
      rate_under18:{ label: 'Aged under 18 (school leaving age to 17)',rate:  8.00, unit: '£/hour' },
      apprentice:  { label: 'Apprentice rate',                          rate:  8.00, unit: '£/hour', note: 'Applies to apprentices under 19, or 19+ in first year of apprenticeship' },
    },
    previous: {
      '2025-26': { nlw_21_plus: 12.21, rate_18_20: 10.00, rate_under18: 7.55, apprentice: 7.55 },
      '2024-25': { nlw_21_plus: 11.44, rate_18_20:  8.60, rate_under18: 6.40, apprentice: 6.40 },
    },
  },

  ni: {
    label: 'National Insurance (Class 1)',
    tax_year: '2026-27',
    employee: {
      primary_threshold_annual:   12570,
      primary_threshold_weekly:     242,
      primary_threshold_monthly:   1048,
      upper_earnings_limit_annual: 50270,
      upper_earnings_limit_weekly:  967,
      rate_between_pt_and_uel:     0.08,
      rate_above_uel:              0.02,
      note: '8% on earnings between Primary Threshold and Upper Earnings Limit; 2% above UEL',
    },
    employer: {
      secondary_threshold_annual:  5000,
      secondary_threshold_weekly:    96,
      secondary_threshold_monthly:  417,
      standard_rate:               0.15,
      note: '15% on all earnings above Secondary Threshold (£5,000/year). Reduced to 0% for under-21s and apprentices under 25 up to UEL.',
    },
    lower_earnings_limit_annual:   6500,
    lower_earnings_limit_weekly:    125,
    employment_allowance:         10500,
    employment_allowance_note:    'Up to £10,500 per tax year off employer NI bill. Not available to sole directors with no other employees.',
  },

  statutory_pay: {
    label: 'Statutory Pay Rates',
    tax_year: '2026-27',
    ssp: {
      label: 'Statutory Sick Pay (SSP)',
      weekly_rate: 123.25,
      qualifying_days: 'Payable from the 4th qualifying day of sickness (3 waiting days)',
      max_weeks: 28,
      lower_earnings_limit: 123,
      note: 'Employee must earn at least £123/week (Lower Earnings Limit) to qualify',
      source_url: 'https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2026-to-2027',
    },
    smp: {
      label: 'Statutory Maternity Pay (SMP)',
      first_6_weeks: '90% of average weekly earnings (AWE) — no cap',
      remaining_33_weeks_rate: 194.32,
      remaining_33_weeks_note: '£194.32/week or 90% of AWE, whichever is lower',
      total_weeks: 39,
      qualifying_earnings_threshold: 123,
    },
    spp: {
      label: 'Statutory Paternity Pay (SPP)',
      weekly_rate: 194.32,
      note: '£194.32/week or 90% of AWE, whichever is lower',
      max_weeks: 2,
    },
    sap: {
      label: 'Statutory Adoption Pay (SAP)',
      first_6_weeks: '90% of AWE — no cap',
      remaining_33_weeks_rate: 194.32,
      total_weeks: 39,
    },
    shpp: {
      label: 'Statutory Shared Parental Pay (ShPP)',
      weekly_rate: 194.32,
      note: '£194.32/week or 90% of AWE, whichever is lower',
    },
    spbp: {
      label: 'Statutory Parental Bereavement Pay (SPBP)',
      weekly_rate: 194.32,
    },
    sncp: {
      label: 'Statutory Neonatal Care Pay (SNCP)',
      weekly_rate: 194.32,
      note: 'New from April 2025. Up to 12 weeks for babies requiring neonatal care.',
    },
  },

  redundancy: {
    label: 'Statutory Redundancy Pay',
    effective_from: '2026-04-06',
    weekly_pay_cap: 751,
    max_years_service: 20,
    max_total_payment: 22530,
    formula: {
      under_22:  { multiplier: 0.5, description: 'Half a week\'s pay per full year of service (age under 22)' },
      age_22_40: { multiplier: 1.0, description: 'One week\'s pay per full year of service (age 22 to 40)' },
      age_41_plus:{ multiplier: 1.5, description: 'One and a half week\'s pay per full year of service (age 41 and over)' },
    },
    eligibility_min_years: 2,
    note: 'Weekly pay capped at £751. Service capped at 20 years. Maximum payment = 30 weeks × £751 = £22,530.',
    previous_caps: {
      '2025-26': 719,
      '2024-25': 643,
    },
    source_url: 'https://www.gov.uk/redundancy-your-rights/redundancy-pay',
  },

  tribunal: {
    label: 'Employment Tribunal Compensation Limits',
    tax_year: '2026-27',
    effective_from: '2026-04-06',
    weekly_pay_cap: 751,
    basic_award_max: 22530,
    compensatory_award_max: 115115,
    compensatory_award_note: 'Capped at the lower of £115,115 or 52 weeks\' gross pay. No cap for certain dismissals (whistleblowing, health & safety).',
    note: 'Limits apply to unfair dismissal claims. Discrimination awards are uncapped.',
    source_url: 'https://www.gov.uk/employment-tribunal-decisions',
  },

  pension: {
    label: 'Auto-Enrolment Pension Thresholds',
    tax_year: '2026-27',
    earnings_trigger: 10000,
    earnings_trigger_note: 'Employees earning over £10,000/year must be auto-enrolled',
    lower_qualifying_earnings: 6240,
    upper_qualifying_earnings: 50270,
    contributions: {
      min_employee: 0.05,
      min_employer: 0.03,
      min_total: 0.08,
      note: 'Minimum 5% employee + 3% employer = 8% total on qualifying earnings band',
    },
    source_url: 'https://www.thepensionsregulator.gov.uk',
  },

  tax: {
    label: 'Income Tax Rates and Bands (England, Wales, Northern Ireland)',
    tax_year: '2026-27',
    personal_allowance: 12570,
    personal_allowance_note: 'Reduced by £1 for every £2 earned above £100,000',
    bands: {
      basic:      { rate: 0.20, from: 12571, to: 50270, label: '20% basic rate' },
      higher:     { rate: 0.40, from: 50271, to: 125140, label: '40% higher rate' },
      additional: { rate: 0.45, from: 125141, to: null, label: '45% additional rate' },
    },
    scottish_note: 'Scotland has different income tax rates and bands set by the Scottish Parliament.',
  },

  student_loans: {
    label: 'Student Loan Deduction Thresholds',
    tax_year: '2026-27',
    plans: {
      plan1: { threshold_annual: 26900, rate: 0.09, label: 'Plan 1 — pre-2012 English/Welsh loans, Scottish loans' },
      plan2: { threshold_annual: 29385, rate: 0.09, label: 'Plan 2 — post-2012 English/Welsh loans' },
      plan4: { threshold_annual: 33795, rate: 0.09, label: 'Plan 4 — Scottish loans from 2021-22' },
      plan5: { threshold_annual: 25000, rate: 0.09, label: 'Plan 5 — loans from August 2023 onwards' },
      postgrad: { threshold_annual: 21000, rate: 0.06, label: 'Postgraduate loan' },
    },
  },
}

// ── Redundancy calculator ─────────────────────────────────────────────────────

function calculateRedundancy(ageAtRedundancy: number, yearsService: number, weeklyPay: number): {
  weeks: number; payment: number; breakdown: string[]; capped_weekly_pay: number
} {
  const cappedPay = Math.min(weeklyPay, DB.redundancy.weekly_pay_cap)
  const cappedYears = Math.min(yearsService, DB.redundancy.max_years_service)
  const breakdown: string[] = []
  let weeks = 0

  // Work backwards through service years from current age
  let currentAge = ageAtRedundancy
  for (let y = 0; y < cappedYears; y++) {
    const ageInYear = currentAge - y
    if (ageInYear >= 41) { weeks += 1.5; breakdown.push(`Age ${ageInYear}: 1.5 weeks`) }
    else if (ageInYear >= 22) { weeks += 1.0; breakdown.push(`Age ${ageInYear}: 1 week`) }
    else { weeks += 0.5; breakdown.push(`Age ${ageInYear}: 0.5 weeks`) }
  }

  return {
    weeks: Math.round(weeks * 10) / 10,
    payment: Math.round(weeks * cappedPay * 100) / 100,
    breakdown: breakdown.reverse(),
    capped_weekly_pay: cappedPay,
  }
}

// ── OAuth 2.0 ─────────────────────────────────────────────────────────────────

function b64url(buf: Buffer): string { return buf.toString('base64url') }

function signJWT(payload: Record<string, unknown>, expiresInSec: number): string {
  const hdr = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const now = Math.floor(Date.now() / 1000)
  const bdy = b64url(Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + expiresInSec })))
  const sig = b64url(crypto.createHmac('sha256', JWT_SECRET).update(`${hdr}.${bdy}`).digest())
  return `${hdr}.${bdy}.${sig}`
}

function verifyJWT(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [hdr, bdy, sig] = parts
    const sigBuf = Buffer.from(sig, 'base64url')
    const expectedBuf = crypto.createHmac('sha256', JWT_SECRET).update(`${hdr}.${bdy}`).digest()
    if (sigBuf.length !== expectedBuf.length) return null
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null
    const payload = JSON.parse(Buffer.from(bdy, 'base64url').toString()) as Record<string, unknown>
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch { return null }
}

function verifyPKCE(verifier: string, challenge: string, method: string): boolean {
  if (method === 'plain') {
    if (verifier.length !== challenge.length) return false
    return crypto.timingSafeEqual(Buffer.from(verifier), Buffer.from(challenge))
  }
  if (method === 'S256') {
    const computed = b64url(crypto.createHash('sha256').update(verifier).digest())
    if (computed.length !== challenge.length) return false
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(challenge))
  }
  return false
}

interface AuthCodeData {
  key: string; clientId: string; redirectUri: string
  codeChallenge?: string; codeChallengeMethod?: string; expiresAt: number
}
const authCodes = new Map<string, AuthCodeData>()
setInterval(() => { const n = Date.now(); for (const [k, v] of authCodes) if (v.expiresAt < n) authCodes.delete(k) }, 60_000)

async function validateKey(key: string): Promise<boolean> {
  if (!key) return false
  if (REVIEWER_KEY && key === REVIEWER_KEY) return true
  const payload = verifyJWT(key)
  return payload !== null && payload.type === 'licence_key' && typeof payload.sub === 'string'
}

function generateLicenceKey(email: string, stripeSubId: string): string {
  return signJWT({ sub: email, stripe_sub: stripeSubId, type: 'licence_key' }, 60 * 60 * 24 * 40)
}

function verifyStripeSignature(payload: string, sigHeader: string, secret: string): boolean {
  try {
    const parts: Record<string, string> = {}
    for (const part of sigHeader.split(',')) {
      const eq = part.indexOf('=')
      if (eq > 0) parts[part.slice(0, eq)] = part.slice(eq + 1)
    }
    if (!parts.t || !parts.v1) return false
    const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${payload}`).digest('hex')
    const expectedBuf = Buffer.from(expected, 'hex')
    const actualBuf = Buffer.from(parts.v1, 'hex')
    if (expectedBuf.length !== actualBuf.length) return false
    return crypto.timingSafeEqual(expectedBuf, actualBuf)
  } catch { return false }
}

async function sendLicenceEmail(email: string, key: string, isRenewal = false): Promise<void> {
  const subject = isRenewal
    ? 'Your ClearRates licence key has been renewed'
    : 'Your ClearRates licence key — getting started'
  const configSnippet = `{"mcpServers":{"clearrates":{"command":"npx","args":["-y","mcp-remote","https://clearrates.onrender.com/mcp","--header","Authorization:Bearer ${key}"]}}}`
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#0a0f1e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;"><div style="max-width:600px;margin:0 auto;padding:40px 24px;"><img src="https://raw.githubusercontent.com/clearcheck-uk/clearrates/main/public/favicon.png" width="48" height="48" style="border-radius:10px;margin-bottom:24px;display:block;"><h1 style="color:#fff;font-size:24px;font-weight:800;margin:0 0 12px;">${isRenewal ? 'Your licence key has been renewed' : 'Welcome to ClearRates'}</h1><p style="color:#94a3b8;font-size:16px;margin:0 0 32px;line-height:1.6;">${isRenewal ? 'Your subscription has renewed. Here is your updated licence key.' : 'Thanks for subscribing. Copy your licence key below — you will need it to connect ClearRates to Claude.'}</p><div style="background:#1a2744;border:1px solid #1e3a5f;border-radius:10px;padding:20px;margin-bottom:32px;"><p style="color:#94a3b8;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;margin:0 0 10px;">Your licence key — keep this safe</p><code style="color:#22c55e;font-size:13px;word-break:break-all;font-family:'SF Mono','Fira Code',monospace;line-height:1.6;">${key}</code></div><h3 style="color:#fff;font-size:16px;font-weight:700;margin:0 0 16px;">How to connect</h3><div style="background:#1a2744;border:1px solid #1e3a5f;border-radius:10px;padding:20px;margin-bottom:16px;"><p style="color:#22c55e;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;margin:0 0 8px;">Option A — Claude.ai (web)</p><p style="color:#94a3b8;font-size:14px;margin:0;line-height:1.6;">1. Go to <a href="https://claude.ai" style="color:#22c55e;">claude.ai</a> and open Settings → Integrations<br>2. Find ClearRates in the connector directory and click Connect<br>3. Enter your licence key above when prompted</p></div><div style="background:#1a2744;border:1px solid #1e3a5f;border-radius:10px;padding:20px;margin-bottom:32px;"><p style="color:#22c55e;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;margin:0 0 8px;">Option B — Claude Desktop (app)</p><p style="color:#94a3b8;font-size:14px;margin:0 0 12px;line-height:1.6;">Add this to your <code style="color:#22c55e;">claude_desktop_config.json</code>:</p><code style="color:#22c55e;font-size:11px;word-break:break-all;font-family:'SF Mono','Fira Code',monospace;line-height:1.6;">${configSnippet.replace(/</g, '&lt;')}</code><p style="color:#94a3b8;font-size:13px;margin:12px 0 0;">Then restart Claude Desktop.</p></div><p style="color:#94a3b8;font-size:14px;margin:0 0 8px;">Once connected, try asking: <em style="color:#fff;">"What is the current National Living Wage?"</em></p><hr style="border:none;border-top:1px solid #1e3a5f;margin:32px 0 24px;"><p style="color:#475569;font-size:13px;margin:0;">Questions? Reply to this email or contact <a href="mailto:traveltaxdesk@gmail.com" style="color:#22c55e;">traveltaxdesk@gmail.com</a></p><p style="color:#475569;font-size:12px;margin:12px 0 0;"><a href="https://clearcheck-uk.github.io/clearrates" style="color:#475569;">clearcheck-uk.github.io/clearrates</a> · UK Statutory Employment Rates for Claude</p></div></body></html>`

  await axios.post('https://api.resend.com/emails', {
    from: 'ClearRates <onboarding@resend.dev>',
    to: email,
    subject,
    html,
  }, {
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 10000,
  })
}

async function validateToken(token: string): Promise<boolean> {
  if (!token) return false
  if (REVIEWER_KEY && token === REVIEWER_KEY) return true
  const payload = verifyJWT(token)
  return payload !== null && typeof payload.sub === 'string' && payload.sub.length > 0
}

function authorizeHTML(opts: {
  clientId: string; redirectUri: string; state: string
  codeChallenge: string; codeChallengeMethod: string; error?: string
}): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ClearRates — Connect</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1624;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#1a2744;border:1px solid #1e3a5f;border-radius:16px;padding:40px;max-width:420px;width:90%}.logo{display:flex;align-items:center;gap:10px;margin-bottom:24px}.logo img{width:40px;height:40px;border-radius:8px}.logo span{font-size:22px;font-weight:700}h1{font-size:20px;font-weight:600;margin-bottom:8px}p{color:#94a3b8;font-size:14px;margin-bottom:24px;line-height:1.5}label{display:block;font-size:13px;font-weight:600;color:#94a3b8;margin-bottom:6px}input[type=password]{width:100%;background:#0f1624;border:1px solid #1e3a5f;border-radius:8px;padding:12px 14px;color:#fff;font-size:14px;outline:none;transition:border-color .2s}input[type=password]:focus{border-color:#22c55e}button{width:100%;background:#22c55e;color:#000;border:none;border-radius:8px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;margin-top:16px;transition:background .2s}button:hover{background:#16a34a}.err{color:#f87171;font-size:13px;margin-top:12px;padding:10px;background:rgba(248,113,113,.1);border-radius:6px}.sub{color:#64748b;font-size:12px;margin-top:20px;text-align:center}a{color:#22c55e}</style></head><body><div class="card"><div class="logo"><img src="/public/favicon.png" alt="ClearRates"><span>ClearRates</span></div><h1>Connect to Claude</h1><p>Enter your ClearRates licence key to give Claude access to always-current UK statutory employment rates.</p><form method="POST"><input type="hidden" name="client_id" value="${esc(opts.clientId)}"><input type="hidden" name="redirect_uri" value="${esc(opts.redirectUri)}"><input type="hidden" name="state" value="${esc(opts.state)}"><input type="hidden" name="code_challenge" value="${esc(opts.codeChallenge)}"><input type="hidden" name="code_challenge_method" value="${esc(opts.codeChallengeMethod)}"><label for="key">Licence Key</label><input id="key" name="key" type="password" placeholder="clearrates-..." required autofocus>${opts.error ? `<div class="err">${esc(opts.error)}</div>` : ''}<button type="submit">Connect →</button></form><p class="sub">No licence key? <a href="https://clearcheck-uk.github.io/clearrates" target="_blank">Get access →</a></p></div></body></html>`
}

// ── MCP server ────────────────────────────────────────────────────────────────

function buildServer() {
  const server = new McpServer({
    name: 'clearrates',
    version: '1.0.0',
    description: 'Always-current UK statutory employment rates for HR professionals, payroll managers, and accountants. Covers NMW/NLW, NI thresholds, SSP, SMP, SPP, redundancy pay, tribunal limits, and auto-enrolment thresholds — updated every April.',
  })

  // Tool 1 — Get current rates (main tool)
  server.tool(
    'get_rates',
    'Get the current UK statutory employment rates and thresholds for the 2026-27 tax year. Returns accurate, up-to-date figures for: National Minimum/Living Wage, National Insurance thresholds and rates, Statutory Sick Pay, Statutory Maternity/Paternity/Adoption Pay, auto-enrolment pension thresholds, income tax bands, and student loan thresholds. Specify a category or leave blank for a full summary.',
    {
      category: z.enum([
        'nmw', 'ni', 'statutory_pay', 'ssp', 'smp', 'redundancy',
        'tribunal', 'pension', 'tax', 'student_loans', 'all'
      ]).optional().describe('Category of rates to return. Leave blank or use "all" for a full summary.'),
    },
    { title: 'UK Statutory Employment Rates', readOnlyHint: true },
    async ({ category }) => {
      const cat = category || 'all'
      const lines: string[] = [
        `# UK Statutory Employment Rates — ${DB.current_tax_year}`,
        `*Effective from ${DB.effective_from} · Source: ${DB.source}*`,
        '',
      ]

      if (cat === 'all' || cat === 'nmw') {
        lines.push(`## National Minimum / Living Wage (from 1 April 2026)`)
        lines.push(`| Age Group | Rate |`)
        lines.push(`|---|---|`)
        lines.push(`| 21 and over (National Living Wage) | **£${DB.nmw.rates.nlw_21_plus.rate}/hour** |`)
        lines.push(`| 18 to 20 | £${DB.nmw.rates.rate_18_20.rate}/hour |`)
        lines.push(`| Under 18 | £${DB.nmw.rates.rate_under18.rate}/hour |`)
        lines.push(`| Apprentice | £${DB.nmw.rates.apprentice.rate}/hour |`)
        lines.push(`> ${DB.nmw.rates.apprentice.note}`)
        lines.push('')
      }

      if (cat === 'all' || cat === 'ni') {
        lines.push(`## National Insurance (Class 1) — 2026-27`)
        lines.push(`**Employee:**`)
        lines.push(`- Primary Threshold: £${DB.ni.employee.primary_threshold_annual.toLocaleString()}/year (£${DB.ni.employee.primary_threshold_weekly}/week)`)
        lines.push(`- Rate between PT and UEL (£${DB.ni.employee.upper_earnings_limit_annual.toLocaleString()}): **${DB.ni.employee.rate_between_pt_and_uel * 100}%**`)
        lines.push(`- Rate above UEL: **${DB.ni.employee.rate_above_uel * 100}%**`)
        lines.push(``)
        lines.push(`**Employer:**`)
        lines.push(`- Secondary Threshold: £${DB.ni.employer.secondary_threshold_annual.toLocaleString()}/year (£${DB.ni.employer.secondary_threshold_weekly}/week)`)
        lines.push(`- Rate above Secondary Threshold: **${DB.ni.employer.standard_rate * 100}%**`)
        lines.push(`- Employment Allowance: **£${DB.ni.employment_allowance.toLocaleString()}** off employer NI bill`)
        lines.push(`> ${DB.ni.employer.note}`)
        lines.push('')
      }

      if (cat === 'all' || cat === 'statutory_pay' || cat === 'ssp') {
        lines.push(`## Statutory Sick Pay (SSP)`)
        lines.push(`- **Rate: £${DB.statutory_pay.ssp.weekly_rate}/week**`)
        lines.push(`- Qualifying: ${DB.statutory_pay.ssp.qualifying_days}`)
        lines.push(`- Maximum duration: ${DB.statutory_pay.ssp.max_weeks} weeks`)
        lines.push(`- Minimum earnings to qualify: £${DB.statutory_pay.ssp.lower_earnings_limit}/week`)
        lines.push('')
      }

      if (cat === 'all' || cat === 'statutory_pay' || cat === 'smp') {
        lines.push(`## Statutory Maternity / Paternity / Adoption / Shared Parental Pay`)
        lines.push(`- **SMP (first 6 weeks):** 90% of average weekly earnings (no cap)`)
        lines.push(`- **SMP (weeks 7–39):** £${DB.statutory_pay.smp.remaining_33_weeks_rate}/week or 90% AWE (lower applies)`)
        lines.push(`- **SPP:** £${DB.statutory_pay.spp.weekly_rate}/week or 90% AWE (lower applies) — max ${DB.statutory_pay.spp.max_weeks} weeks`)
        lines.push(`- **SAP, ShPP, SPBP, SNCP:** £${DB.statutory_pay.shpp.weekly_rate}/week or 90% AWE (lower applies)`)
        lines.push(`> ${DB.statutory_pay.sncp.note}`)
        lines.push('')
      }

      if (cat === 'all' || cat === 'redundancy') {
        lines.push(`## Statutory Redundancy Pay`)
        lines.push(`- **Weekly pay cap: £${DB.redundancy.weekly_pay_cap}** (from 6 April 2026)`)
        lines.push(`- Maximum payment: £${DB.redundancy.max_total_payment.toLocaleString()} (30 weeks × £${DB.redundancy.weekly_pay_cap})`)
        lines.push(`- Service capped at ${DB.redundancy.max_years_service} years`)
        lines.push(`- Formula: 0.5 week/year (under 22) · 1 week/year (22–40) · 1.5 weeks/year (41+)`)
        lines.push(`- Minimum service for eligibility: ${DB.redundancy.eligibility_min_years} years`)
        lines.push('')
      }

      if (cat === 'all' || cat === 'tribunal') {
        lines.push(`## Employment Tribunal Compensation Limits`)
        lines.push(`- **Weekly pay cap:** £${DB.tribunal.weekly_pay_cap}`)
        lines.push(`- **Maximum basic award:** £${DB.tribunal.basic_award_max.toLocaleString()}`)
        lines.push(`- **Maximum compensatory award (unfair dismissal):** £${DB.tribunal.compensatory_award_max.toLocaleString()}`)
        lines.push(`> ${DB.tribunal.compensatory_award_note}`)
        lines.push('')
      }

      if (cat === 'all' || cat === 'pension') {
        lines.push(`## Auto-Enrolment Pension Thresholds`)
        lines.push(`- **Earnings trigger:** £${DB.pension.earnings_trigger.toLocaleString()}/year`)
        lines.push(`- **Qualifying earnings band:** £${DB.pension.lower_qualifying_earnings.toLocaleString()} – £${DB.pension.upper_qualifying_earnings.toLocaleString()}/year`)
        lines.push(`- **Minimum contributions:** ${DB.pension.contributions.min_employee * 100}% employee + ${DB.pension.contributions.min_employer * 100}% employer = ${DB.pension.contributions.min_total * 100}% total`)
        lines.push('')
      }

      if (cat === 'all' || cat === 'tax') {
        lines.push(`## Income Tax Bands 2026-27 (England, Wales, Northern Ireland)`)
        lines.push(`- **Personal Allowance:** £${DB.tax.personal_allowance.toLocaleString()}`)
        lines.push(`- **Basic rate (20%):** £${DB.tax.bands.basic.from.toLocaleString()} – £${DB.tax.bands.basic.to.toLocaleString()}`)
        lines.push(`- **Higher rate (40%):** £${DB.tax.bands.higher.from.toLocaleString()} – £${DB.tax.bands.higher.to.toLocaleString()}`)
        lines.push(`- **Additional rate (45%):** above £${DB.tax.bands.additional.from.toLocaleString()}`)
        lines.push(`> ${DB.tax.scottish_note}`)
        lines.push('')
      }

      if (cat === 'all' || cat === 'student_loans') {
        lines.push(`## Student Loan Deduction Thresholds 2026-27`)
        for (const [, plan] of Object.entries(DB.student_loans.plans)) {
          lines.push(`- **${plan.label}:** £${plan.threshold_annual.toLocaleString()}/year — ${plan.rate * 100}% above threshold`)
        }
        lines.push('')
      }

      lines.push(`---`)
      lines.push(`*Tax year: ${DB.current_tax_year} · Effective: ${DB.effective_from} · Source: GOV.UK Open Government Licence v3.0*`)
      lines.push(`*Always verify critical figures at gov.uk before making employment decisions.*`)

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
    }
  )

  // Tool 2 — Redundancy calculator
  server.tool(
    'calculate_redundancy',
    'Calculate the exact statutory redundancy payment for an employee. Applies the correct age-based multiplier (0.5/1/1.5 weeks per year), caps weekly pay at £751 and service at 20 years, and shows a year-by-year breakdown. Essential for HR managers and payroll teams handling redundancies.',
    {
      age: z.number().int().min(16).max(100).describe('Employee\'s age at the date of redundancy'),
      years_service: z.number().min(0).max(50).describe('Complete years of continuous employment (partial years do not count)'),
      weekly_pay: z.number().min(0).describe('Employee\'s gross weekly pay. If paid monthly, divide monthly salary by 4.333'),
    },
    { title: 'Statutory Redundancy Calculator', readOnlyHint: true },
    async ({ age, years_service, weekly_pay }) => {
      if (years_service < DB.redundancy.eligibility_min_years) {
        return {
          content: [{ type: 'text' as const, text: `## Statutory Redundancy: Not Eligible\n\nThe employee has ${years_service} year(s) of service. A minimum of **${DB.redundancy.eligibility_min_years} years** continuous employment is required to qualify for statutory redundancy pay.\n\n*Source: Employment Rights Act 1996 · gov.uk/redundancy-your-rights*` }]
        }
      }

      const result = calculateRedundancy(age, years_service, weekly_pay)
      const lines = [
        `## Statutory Redundancy Calculation`,
        ``,
        `**Employee:** Age ${age} · ${years_service} years service · £${weekly_pay.toFixed(2)}/week`,
        ``,
        `| | |`,
        `|---|---|`,
        `| Weekly pay used | £${result.capped_weekly_pay.toFixed(2)}${weekly_pay > DB.redundancy.weekly_pay_cap ? ` *(capped from £${weekly_pay.toFixed(2)})* ` : ''} |`,
        `| Total weeks | ${result.weeks} |`,
        `| **Statutory redundancy pay** | **£${result.payment.toFixed(2)}** |`,
        ``,
        `### Year-by-year breakdown`,
        ...result.breakdown.map(b => `- ${b}`),
        ``,
        `### Notes`,
        `- Weekly pay capped at **£${DB.redundancy.weekly_pay_cap}** (from 6 April 2026)`,
        `- Service capped at **${DB.redundancy.max_years_service} years**`,
        `- Maximum possible payment: £${DB.redundancy.max_total_payment.toLocaleString()}`,
        ``,
        `*This is the statutory minimum. The employment contract may provide for enhanced redundancy pay.*`,
        `*Source: GOV.UK (OGL v3.0) · Effective 6 April 2026*`,
      ]
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
    }
  )

  // Tool 3 — Fact-check a rate
  server.tool(
    'check_rate',
    'Verify whether a specific UK statutory employment rate or figure is correct for the current tax year. Use this to fact-check figures from other sources, check if a rate Claude previously quoted is accurate, or confirm a rate before using it in calculations or documents.',
    {
      query: z.string().describe('The rate or figure to check, e.g. "is the NLW £12.21 per hour?" or "SSP weekly rate" or "redundancy weekly pay cap"'),
    },
    { title: 'Rate Fact-Checker', readOnlyHint: true },
    async ({ query }) => {
      const q = query.toLowerCase()
      const lines: string[] = [`## Rate Check: ${query}`, `*Tax year: ${DB.current_tax_year} · Effective: ${DB.effective_from}*`, ``]

      // NLW / NMW checks
      if (q.includes('nlw') || q.includes('living wage') || q.includes('national living') || (q.includes('minimum wage') && !q.includes('18') && !q.includes('20') && !q.includes('apprentice'))) {
        lines.push(`**National Living Wage (21 and over): £${DB.nmw.rates.nlw_21_plus.rate}/hour**`)
        lines.push(`Effective from 1 April 2026.`)
        if (q.includes('12.21')) lines.push(`⚠️ £12.21 was the 2025-26 rate. The current rate is £${DB.nmw.rates.nlw_21_plus.rate}.`)
        if (q.includes('12.71')) lines.push(`✅ £12.71 is correct for the current tax year (from 1 April 2026).`)
      } else if (q.includes('ssp') || q.includes('sick pay')) {
        lines.push(`**Statutory Sick Pay (SSP): £${DB.statutory_pay.ssp.weekly_rate}/week**`)
        lines.push(`Qualifying: ${DB.statutory_pay.ssp.qualifying_days}.`)
        lines.push(`Minimum earnings to qualify: £${DB.statutory_pay.ssp.lower_earnings_limit}/week.`)
      } else if (q.includes('smp') || q.includes('maternity pay')) {
        lines.push(`**Statutory Maternity Pay (SMP):**`)
        lines.push(`- First 6 weeks: 90% of average weekly earnings (AWE) — no upper cap`)
        lines.push(`- Weeks 7–39: £${DB.statutory_pay.smp.remaining_33_weeks_rate}/week or 90% AWE, whichever is lower`)
      } else if (q.includes('spp') || q.includes('paternity')) {
        lines.push(`**Statutory Paternity Pay (SPP): £${DB.statutory_pay.spp.weekly_rate}/week** or 90% AWE (whichever is lower)`)
        lines.push(`Maximum: ${DB.statutory_pay.spp.max_weeks} weeks.`)
      } else if (q.includes('redundancy') && (q.includes('cap') || q.includes('weekly') || q.includes('pay'))) {
        lines.push(`**Statutory redundancy weekly pay cap: £${DB.redundancy.weekly_pay_cap}** (from 6 April 2026)`)
        lines.push(`Previous rate (2025-26): £${DB.redundancy.previous_caps['2025-26']}`)
        lines.push(`Maximum redundancy payment: £${DB.redundancy.max_total_payment.toLocaleString()}`)
      } else if (q.includes('compensatory') || q.includes('tribunal') || (q.includes('unfair') && q.includes('dismissal'))) {
        lines.push(`**Employment Tribunal — Unfair Dismissal:**`)
        lines.push(`- Maximum compensatory award: **£${DB.tribunal.compensatory_award_max.toLocaleString()}**`)
        lines.push(`- Maximum basic award: £${DB.tribunal.basic_award_max.toLocaleString()}`)
        lines.push(`- Weekly pay cap: £${DB.tribunal.weekly_pay_cap}`)
        lines.push(`> ${DB.tribunal.compensatory_award_note}`)
      } else if (q.includes('employer') && q.includes('ni') || q.includes('employer ni') || q.includes('employers ni') || q.includes('secondary threshold')) {
        lines.push(`**Employer NI:**`)
        lines.push(`- Rate: **${DB.ni.employer.standard_rate * 100}%** (increased from 13.8% in April 2025)`)
        lines.push(`- Secondary Threshold: **£${DB.ni.employer.secondary_threshold_annual.toLocaleString()}/year** (£${DB.ni.employer.secondary_threshold_weekly}/week)`)
        lines.push(`- Employment Allowance: up to **£${DB.ni.employment_allowance.toLocaleString()}**`)
      } else if (q.includes('employee') && q.includes('ni') || q.includes('primary threshold') || q.includes('employee ni')) {
        lines.push(`**Employee NI:**`)
        lines.push(`- Primary Threshold: **£${DB.ni.employee.primary_threshold_annual.toLocaleString()}/year** (£${DB.ni.employee.primary_threshold_weekly}/week)`)
        lines.push(`- Rate to UEL: **${DB.ni.employee.rate_between_pt_and_uel * 100}%**`)
        lines.push(`- Rate above UEL (£${DB.ni.employee.upper_earnings_limit_annual.toLocaleString()}): **${DB.ni.employee.rate_above_uel * 100}%**`)
      } else if (q.includes('auto') || q.includes('pension') || q.includes('enrolment')) {
        lines.push(`**Auto-Enrolment Pension Thresholds:**`)
        lines.push(`- Earnings trigger: **£${DB.pension.earnings_trigger.toLocaleString()}/year**`)
        lines.push(`- Qualifying earnings band: £${DB.pension.lower_qualifying_earnings.toLocaleString()} – £${DB.pension.upper_qualifying_earnings.toLocaleString()}/year`)
        lines.push(`- Minimum: ${DB.pension.contributions.min_employee * 100}% employee + ${DB.pension.contributions.min_employer * 100}% employer`)
      } else if (q.includes('personal allowance') || q.includes('income tax') || q.includes('basic rate') || q.includes('higher rate')) {
        lines.push(`**Income Tax — 2026-27 (England/Wales/NI):**`)
        lines.push(`- Personal Allowance: **£${DB.tax.personal_allowance.toLocaleString()}**`)
        lines.push(`- Basic rate (20%): up to £${DB.tax.bands.basic.to.toLocaleString()}`)
        lines.push(`- Higher rate (40%): £${DB.tax.bands.higher.from.toLocaleString()} – £${DB.tax.bands.higher.to.toLocaleString()}`)
        lines.push(`- Additional rate (45%): above £${DB.tax.bands.additional.from.toLocaleString()}`)
      } else {
        lines.push(`I couldn't identify the specific rate in your query. Try using \`get_rates\` for a full list of all current UK statutory rates.`)
        lines.push(``)
        lines.push(`**Available categories:** NMW/NLW, NI thresholds, SSP, SMP/SPP/SAP/ShPP, redundancy pay, tribunal limits, pension auto-enrolment, income tax, student loans.`)
      }

      lines.push(``)
      lines.push(`*Source: GOV.UK (OGL v3.0) · Tax year ${DB.current_tax_year} · Effective ${DB.effective_from}*`)
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
    }
  )

  // Tool 4 — Historical rates
  server.tool(
    'get_historical_rates',
    'Look up UK statutory employment rates for previous tax years. Useful for calculating back-pay, checking historical redundancy payments, or verifying what the rates were during a specific period of employment.',
    {
      tax_year: z.enum(['2025-26', '2024-25', '2023-24']).describe('The tax year to look up'),
      category: z.enum(['nmw', 'redundancy']).optional().describe('Category of rates. Currently supports NMW and redundancy caps.'),
    },
    { title: 'Historical UK Employment Rates', readOnlyHint: true },
    async ({ tax_year, category }) => {
      const lines: string[] = [`## UK Statutory Rates — ${tax_year}`, ``]

      if (!category || category === 'nmw') {
        const prev = DB.nmw.previous[tax_year as keyof typeof DB.nmw.previous]
        if (prev) {
          lines.push(`### National Minimum / Living Wage`)
          lines.push(`| Category | Rate |`)
          lines.push(`|---|---|`)
          lines.push(`| 21 and over (NLW) | £${prev.nlw_21_plus}/hour |`)
          lines.push(`| 18 to 20 | £${prev.rate_18_20}/hour |`)
          lines.push(`| Under 18 | £${prev.rate_under18}/hour |`)
          lines.push(`| Apprentice | £${prev.apprentice}/hour |`)
          lines.push(``)
        } else {
          lines.push(`NMW historical data not available for ${tax_year}.`)
        }
      }

      if (!category || category === 'redundancy') {
        const prevCap = DB.redundancy.previous_caps[tax_year as keyof typeof DB.redundancy.previous_caps]
        if (prevCap) {
          lines.push(`### Statutory Redundancy Weekly Pay Cap`)
          lines.push(`**£${prevCap}/week** (${tax_year})`)
          lines.push(``)
        }
      }

      lines.push(`*Source: GOV.UK (OGL v3.0)*`)
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
    }
  )

  return server
}

// ── Express HTTP server ───────────────────────────────────────────────────────

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use('/public', express.static('public'))

app.get('/favicon.ico', (_req, res) => res.redirect('/public/favicon.png'))
app.get('/', (_req, res) => res.send('<html><head><link rel="icon" href="/public/favicon.png"><title>ClearRates</title></head><body><h1>ClearRates</h1><p>Always-current UK statutory employment rates for Claude.</p></body></html>'))
app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok', service: 'clearrates-mcp', version: '1.0.0' }))

// ── OAuth 2.0 endpoints ───────────────────────────────────────────────────────

app.get('/.well-known/oauth-authorization-server', (_req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/authorize`,
    token_endpoint: `${BASE_URL}/token`,
    registration_endpoint: `${BASE_URL}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  })
})

app.post('/register', (req: Request, res: Response) => {
  res.status(201).json({
    client_id: crypto.randomBytes(16).toString('hex'),
    client_secret_expires_at: 0,
    redirect_uris: (req.body as any).redirect_uris || [],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  })
})

app.get('/authorize', (req: Request, res: Response) => {
  const q = req.query as Record<string, string>
  if (q.response_type !== 'code' || !q.redirect_uri) { res.status(400).send('Invalid request'); return }
  res.send(authorizeHTML({ clientId: q.client_id || '', redirectUri: q.redirect_uri, state: q.state || '', codeChallenge: q.code_challenge || '', codeChallengeMethod: q.code_challenge_method || 'S256' }))
})

app.post('/authorize', async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, string>
  const { client_id = '', redirect_uri = '', state = '', code_challenge = '', code_challenge_method = 'S256', key = '' } = b
  if (!redirect_uri) { res.status(400).send('Missing redirect_uri'); return }
  const valid = await validateKey(key)
  if (!valid) {
    res.send(authorizeHTML({ clientId: client_id, redirectUri: redirect_uri, state, codeChallenge: code_challenge, codeChallengeMethod: code_challenge_method, error: 'Invalid licence key. Get access at clearcheck-uk.github.io/clearrates' }))
    return
  }
  const code = crypto.randomBytes(24).toString('hex')
  authCodes.set(code, { key, clientId: client_id, redirectUri: redirect_uri, codeChallenge: code_challenge || undefined, codeChallengeMethod: code_challenge_method || undefined, expiresAt: Date.now() + 600_000 })
  res.redirect(`${redirect_uri}?${new URLSearchParams({ code, ...(state ? { state } : {}) })}`)
})

app.post('/token', async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, string>
  const { grant_type, code, redirect_uri, code_verifier } = b
  if (grant_type !== 'authorization_code' || !code) { res.status(400).json({ error: 'unsupported_grant_type' }); return }
  const entry = authCodes.get(code)
  if (!entry || entry.expiresAt < Date.now()) { authCodes.delete(code); res.status(400).json({ error: 'invalid_grant' }); return }
  if (entry.redirectUri !== redirect_uri) { res.status(400).json({ error: 'invalid_grant' }); return }
  if (entry.codeChallenge && entry.codeChallengeMethod) {
    if (!code_verifier || !verifyPKCE(code_verifier, entry.codeChallenge, entry.codeChallengeMethod)) { res.status(400).json({ error: 'invalid_grant' }); return }
  }
  authCodes.delete(code)
  res.json({ access_token: signJWT({ sub: entry.key }, 60 * 60 * 24 * 30), token_type: 'bearer', expires_in: 60 * 60 * 24 * 30 })
})

// ── Stripe webhook ────────────────────────────────────────────────────────────

app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string
  const payload = (req.body as Buffer).toString()

  if (!verifyStripeSignature(payload, sig || '', STRIPE_WEBHOOK_SECRET)) {
    res.status(400).json({ error: 'Invalid signature' }); return
  }

  const event = JSON.parse(payload)

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object
      const email = session.customer_details?.email || session.customer_email
      const subId = session.subscription || session.id
      if (email && subId) {
        const key = generateLicenceKey(email, subId)
        await sendLicenceEmail(email, key, false)
        console.log(`Licence key sent to ${email}`)
      }
    }

    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object
      const isRenewal = invoice.billing_reason === 'subscription_cycle'
      if (isRenewal) {
        const email = invoice.customer_email
        const subId = invoice.subscription
        if (email && subId) {
          const key = generateLicenceKey(email, subId)
          await sendLicenceEmail(email, key, true)
          console.log(`Renewal key sent to ${email}`)
        }
      }
    }
  } catch (e: any) {
    console.error('Webhook handler error:', e.message)
  }

  res.json({ received: true })
})

// ── MCP handler ───────────────────────────────────────────────────────────────

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true
  return ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed.trim()))
}

async function mcpHandler(req: Request, res: Response) {
  if (req.method !== 'DELETE' && !isAllowedOrigin(req.headers.origin)) { res.status(403).json({ error: 'Origin not allowed' }); return }
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim()
  if (!await validateToken(token)) { res.status(401).json({ error: 'Invalid or missing access token.', info: 'Get access at clearcheck-uk.github.io/clearrates' }); return }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  const server = buildServer()
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
}

app.post('/mcp', mcpHandler)
app.get('/mcp', mcpHandler)
app.delete('/mcp', async (req: Request, res: Response) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  await transport.handleRequest(req, res)
})

app.listen(PORT, () => console.log(`ClearRates MCP running on :${PORT}`))

# ClearRates — UK Statutory Employment Rates for Claude

Always-current UK statutory employment rates, directly inside Claude.

Designed for UK HR professionals, payroll managers, accountants, and employment solicitors who need accurate statutory figures — not the outdated rates Claude's training data provides.

## The problem

Claude's training data goes out of date. Every April, UK statutory rates change. Without ClearRates, Claude confidently quotes last year's figures.

## What it covers

- **National Minimum / Living Wage** — all age groups, updated every April
- **National Insurance** — employee and employer rates, thresholds, Employment Allowance
- **Statutory Sick Pay (SSP)** — weekly rate, qualifying conditions
- **Statutory Maternity / Paternity / Adoption / Shared Parental Pay** — current weekly rates
- **Redundancy pay calculator** — age-based multipliers, capped at current limits
- **Employment Tribunal limits** — basic award, compensatory award caps
- **Auto-enrolment pension thresholds** — earnings trigger, qualifying earnings band
- **Income tax bands** — personal allowance, basic/higher/additional rate thresholds
- **Student loan deduction thresholds** — Plans 1, 2, 4, 5 and postgraduate

## Example usage

```
What is the current National Living Wage?
```

```
Calculate statutory redundancy pay for an employee aged 47, 11 years service, £820/week
```

```
What is the current SSP weekly rate and how long can it be paid?
```

```
Is the employer NI rate currently 13.8% or 15%?
```

## Tools

| Tool | Description |
|---|---|
| `get_rates` | All current statutory rates, optionally filtered by category |
| `calculate_redundancy` | Statutory redundancy pay calculator with year-by-year breakdown |
| `check_rate` | Fact-check a specific rate or figure |
| `get_historical_rates` | Look up rates for previous tax years |

## Setup

1. Get a licence key at [clearcheck-uk.github.io/clearrates](https://clearcheck-uk.github.io/clearrates)
2. Add to Claude Desktop config:

```json
{
  "mcpServers": {
    "clearrates": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://clearrates.onrender.com/mcp", "--header", "Authorization:Bearer YOUR_LICENCE_KEY"]
    }
  }
}
```

3. Restart Claude Desktop — ClearRates tools are ready

## Pricing

£99/month — unlimited lookups, all tools, always current

## Terms of Service

By using ClearRates you agree to: (1) use the service only for lawful purposes; (2) not attempt to reverse-engineer or abuse the API; (3) accept that results are provided for decision-support only and carry no legal warranty; (4) verify critical figures independently before making employment decisions. Subscriptions are billed monthly and may be cancelled at any time. ClearRates reserves the right to suspend access for misuse. Governed by the laws of England and Wales.

## Legal

ClearRates is a decision-support tool. It is not legal or HR advice. Always verify statutory figures before making employment decisions.

Data source: GOV.UK (Open Government Licence v3.0) — rates updated annually each April.

## Privacy Policy

See [PRIVACY.md](./PRIVACY.md)

## Support

traveltaxdesk@gmail.com

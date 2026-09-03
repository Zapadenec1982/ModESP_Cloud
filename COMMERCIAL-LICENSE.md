# ModESP Cloud Commercial Licence (draft)

> **Status: draft for legal review.** The public repository is licensed under the
> [PolyForm Noncommercial License 1.0.0](LICENSE), which permits only noncommercial use.
> Any for-profit use by a party other than the licensor — a service company running its own
> instance, a white-label reseller, a retail chain self-hosting, an integrator bundling the
> software — requires this separate commercial licence. Nothing in this file changes the terms
> of the public licence; it is an additional agreement granted case by case.

## 1. Parties

- **Licensor:** the legal entity named in the `Required Notice` of [LICENSE](LICENSE) (to be
  aligned with the contracting entity before the first commercial licence is signed).
- **Licensee:** the organisation named in the signed order form.

## 2. What is licensed

| Edition | Grant | Typical licensee |
|---|---|---|
| **Self-hosted** | Run one production instance of ModESP Cloud (backend, WebUI, infra) on Licensee's own infrastructure for Licensee's own refrigeration fleet | Retail chain, public-health warehouse, large producer |
| **Partner / white-label** | Run one instance, or use the hosted service, to provide monitoring to Licensee's own customers under Licensee's brand; create and administer customer tenants | Refrigeration service company, integrator |
| **OEM** | Bundle the cloud with controllers sold by Licensee, with the right to sublicense the hosted service to end customers | Cabinet or controller manufacturer |

All editions include: the right to modify the software for internal use, security updates and
minor versions for the licence term, and access to the migration runner and deployment scripts.

## 3. What is not licensed

- Redistribution of the source code or binaries to third parties outside the licensed edition.
- Removal of the copyright notice, the `© OpenStreetMap contributors` attribution, or other
  third-party notices.
- Use of the ModESP name or logo other than as "Powered by ModESP Cloud" where the edition
  allows it.
- Use of third-party geo services (Nominatim, Open-Meteo, OSRM, OpenRouteService, OSM tiles)
  on their free or non-commercial terms. Licensee is responsible for licensing or self-hosting
  those services for its instance (see `docs/THIRD_PARTY_LICENSING.md`).

## 4. Fees (to be set in the order form)

- Self-hosted: annual fee per instance plus an optional support fee (the business analysis
  proposes from 200,000 UAH per year plus 20 % support).
- Partner: platform fee per month plus a per-controller rate for managed controllers; partner
  margin on resale is set in the partner agreement (`docs/legal/PARTNER-AGREEMENT_UA.md`).
- OEM: negotiated per volume.

## 5. Support and updates

- Security fixes for the licensed major version for the licence term.
- Named support channel and response targets as defined in
  `docs/legal/SERVICE-DESCRIPTION_UA.md` or in the order form.
- Licensee must apply security updates within 30 days of release to keep support entitlement.

## 6. Data and compliance

- Licensee is the data controller for its own tenants and customers; the licensor is not a
  processor for self-hosted instances.
- For the hosted service, `docs/legal/DPA_UA.md` applies.

## 7. Term and termination

- Annual term, renewed by the order form. On termination the Licensee stops using the software
  within 30 days, keeps its own data, and may run the instance read-only for data export for
  a further 30 days.

## 8. Warranty and liability

- Software is provided with a limited warranty of conformance to the documentation for 90 days.
- Liability is capped at the fees paid in the preceding 12 months and excludes indirect losses,
  including loss of goods due to refrigeration failure. Remote commands and firmware updates are
  executed at Licensee's instruction and risk.

## 9. How to obtain

Contact: https://github.com/Zapadenec1982 (to be replaced by a sales e-mail on the public site).

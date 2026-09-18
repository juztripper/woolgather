# Security policy

Security and data-boundary reports are taken seriously.

## Supported version

The current `main` branch is the only supported source version. The hosted application may run a specific reviewed commit rather than every change on `main`.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting for this repository when available. If that is unavailable, email [support@rippersgames.com](mailto:support@rippersgames.com) with the subject `woolgather security report`.

Include:

- the affected route, component, or commit;
- reproducible steps or a minimal proof of concept;
- the potential impact;
- any suggested mitigation;
- a safe way to contact you.

Do not access other people's data, degrade the service, perform social engineering, or run automated high-volume tests against the hosted application. Use synthetic accounts and the smallest test necessary to demonstrate the issue.

We will acknowledge a report, investigate it, and coordinate disclosure according to its severity and scope. Please allow time for a fix before public disclosure.

## Secrets and deployment data

No secret belongs in this repository. Public Supabase identifiers and publishable browser keys are not authority by themselves; service-role credentials, signing secrets, provider keys, webhook secrets, customer data, and operational traces must remain outside Git.

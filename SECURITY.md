# Security Policy

## Supported Versions

Only the latest minor release receives security fixes. Older versions are not patched, so please upgrade before reporting.

## Reporting a Vulnerability

Open a private security advisory on GitHub (Security tab, Report a vulnerability) or open an issue with the details. Include:

* A short description of the problem
* Steps to reproduce
* The version you tested with

We aim to acknowledge reports within 7 days. Please do not disclose the issue publicly until a fix is released.

## Scope Notes

This plugin handles API keys. It never sends keys anywhere except the provider endpoints configured by the user, and it masks keys in logs and status output. See `documents/06-security.md` for the full key handling notes.

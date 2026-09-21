# Privacy release checklist

The privacy draft is not publishable until every blocking item below is resolved.

## Product owner input

- [x] Legal name or individual name of the personal information processor
- [x] Registered or principal business location
- [x] Monitored privacy-rights email address
- [x] General support channel
- [ ] Policy effective date
- [ ] Retention period for audit records
- [ ] Retention period for authentication, security, and application logs
- [ ] Maximum backup deletion cycle
- [ ] User-request response target and identity-verification procedure

## Engineering

- [ ] Add a self-service account deletion or a tested operator deletion workflow
- [ ] Add a separate, unbundled cross-border personal-information consent before signup
- [ ] Store consent text version, timestamp, user ID, and withdrawal status
- [ ] Prevent public signup until the separate consent and operator details are complete
- [ ] Configure production SMTP and disclose the selected email provider
- [ ] Confirm production web/API hosting locations and update the policy
- [ ] Verify that secrets never enter the browser bundle or logs
- [ ] Test export, access, correction, deletion, and consent-withdrawal requests
- [ ] Define and test incident notification procedures

## Compliance review

- [ ] Complete and retain a personal information protection impact assessment
- [ ] Determine the applicable China data-export route based on operator status, data types,
      user counts, and current regulations
- [ ] Review and accept the current Supabase DPA and authorized subprocessors
- [ ] Verify the overseas recipient name, contact route, purposes, data types, and retention
- [ ] Obtain legal review before public launch
- [ ] Create a dedicated policy and guardian-consent flow before allowing users under 14

## Future features

Repeat the privacy review before enabling:

- photo or camera upload;
- scan-mat and CV processing;
- inventory and build-progress data;
- Agent processing or any external model/API;
- analytics, crash reporting, advertising, or behavioral tracking;
- sharing links, collaboration, or public project pages.

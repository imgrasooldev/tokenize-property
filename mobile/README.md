# Property Token mobile app (Flutter)

The investor app of ADR 0018, phase 1 (read-only): sign-in with the website (OAuth 2.0 Device Authorization Grant), offerings, portfolio, inbox and account, in English and Urdu (right to left), with the Night Glass dark theme and a Daylight-style light theme.

## Architecture

```
lib/
  app/        dependency injection, router (go_router, sign-in redirect), themes and languages
  core/       network (ApiClient: bearer token, one refresh on 401, RFC 9457 / RFC 6749 errors),
              storage (tokens in the platform keystore only), theme, formatting, LoaderBloc
  features/<feature>/
    domain/        entities and the repository interface
    data/          the repository implementation against /v1 (docs/api/openapi.json)
    presentation/  BLoC (flutter_bloc) and pages
  l10n/       app_en.arb, app_ur.arb (flutter gen-l10n)
```

Presentation talks only to blocs, blocs only to repository interfaces, repositories only to the API client. Tests replace the repositories (bloc and widget tests) or the HTTP client (repository tests).

## Run

```bash
flutter pub get
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:4960/v1
```

`API_BASE_URL` defaults to the demo server (`http://51.79.144.40/v1`). Android allows plain HTTP only to the demo server and the emulator's host (`res/xml/network_security_config.xml`); production uses HTTPS. iOS needs the production HTTPS domain (App Transport Security is not relaxed).

## Checks

```bash
flutter analyze   # very_good_analysis, strict casts/inference/raw types
flutter test      # bloc_test, repository and widget tests
```

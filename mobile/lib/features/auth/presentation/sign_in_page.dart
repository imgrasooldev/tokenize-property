import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:property_token_app/features/auth/presentation/auth_bloc.dart';
import 'package:property_token_app/l10n/gen/app_localizations.dart';

/// Sign-in with the website (RFC 8628): the investor approves the code on
/// `/device` where they are already signed in (passkey step-up there).
class SignInPage extends StatelessWidget {
  const SignInPage({super.key});

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 440),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: BlocBuilder<AuthBloc, AuthState>(
                builder: (context, state) {
                  return Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Icon(Icons.apartment_rounded, size: 56, color: scheme.primary),
                      const SizedBox(height: 12),
                      Text(l.appTitle, textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineMedium),
                      const SizedBox(height: 24),
                      Text(l.signInTitle, style: Theme.of(context).textTheme.titleLarge),
                      const SizedBox(height: 8),
                      Text(l.signInBody),
                      const SizedBox(height: 24),
                      if (state is AuthAwaitingApproval) ...[
                        Card(
                          child: Padding(
                            padding: const EdgeInsets.all(20),
                            child: Column(
                              children: [
                                Text(l.signInCode),
                                const SizedBox(height: 8),
                                SelectableText(
                                  state.code.userCode,
                                  key: const Key('user-code'),
                                  textDirection: TextDirection.ltr,
                                  style: Theme.of(
                                    context,
                                  ).textTheme.displaySmall?.copyWith(letterSpacing: 4, color: scheme.primary),
                                ),
                                const SizedBox(height: 16),
                                Text(l.signInOpen),
                                const SizedBox(height: 4),
                                SelectableText(state.code.verificationUri, textDirection: TextDirection.ltr),
                                IconButton(
                                  tooltip: state.code.verificationUriComplete,
                                  icon: const Icon(Icons.copy_rounded),
                                  onPressed: () =>
                                      Clipboard.setData(ClipboardData(text: state.code.verificationUriComplete)),
                                ),
                                const SizedBox(height: 8),
                                const LinearProgressIndicator(),
                                const SizedBox(height: 8),
                                Text(l.signInWaiting),
                              ],
                            ),
                          ),
                        ),
                      ] else ...[
                        if (state is AuthSignedOut && state.reason != null)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 12),
                            child: Text(
                              switch (state.reason!) {
                                AuthFailure.denied => l.signInDenied,
                                AuthFailure.expired => l.signInExpired,
                                AuthFailure.network => l.signInFailed,
                              },
                              key: const Key('sign-in-error'),
                              style: TextStyle(color: scheme.error),
                            ),
                          ),
                        FilledButton(
                          key: const Key('sign-in-start'),
                          onPressed: state is AuthUnknown
                              ? null
                              : () => context.read<AuthBloc>().add(const AuthSignInRequested('Property Token app')),
                          child: Text(l.signInStart),
                        ),
                      ],
                    ],
                  );
                },
              ),
            ),
          ),
        ),
      ),
    );
  }
}

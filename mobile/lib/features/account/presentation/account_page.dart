import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:property_token_app/core/bloc/loader_view.dart';
import 'package:property_token_app/features/account/domain/me.dart';
import 'package:property_token_app/features/account/presentation/account_bloc.dart';
import 'package:property_token_app/features/auth/presentation/auth_bloc.dart';
import 'package:property_token_app/features/settings/settings_cubit.dart';
import 'package:property_token_app/l10n/gen/app_localizations.dart';

class AccountPage extends StatelessWidget {
  const AccountPage({super.key});

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final settings = context.watch<SettingsCubit>().state;
    return Scaffold(
      appBar: AppBar(title: Text(l.accountTitle)),
      body: LoaderView<AccountBloc, Me>(
        builder: (context, me) => ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Card(
              child: Column(
                children: [
                  ListTile(title: Text(me.displayName, style: Theme.of(context).textTheme.titleMedium)),
                  ListTile(
                    title: Text(l.kycStatus),
                    trailing: Text(l.kycState(me.kyc), key: const Key('kyc-state')),
                  ),
                  if (me.nonResident) ListTile(title: Text(l.livesAbroad(me.document.toUpperCase()))),
                  if (me.supportReference != null)
                    ListTile(
                      title: Text(l.supportReference),
                      trailing: SelectableText(me.supportReference!, textDirection: TextDirection.ltr),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            Text(l.theme, style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 8),
            SegmentedButton<ThemeMode>(
              segments: [
                ButtonSegment(value: ThemeMode.system, label: Text(l.themeSystem)),
                ButtonSegment(value: ThemeMode.dark, label: Text(l.themeDark)),
                ButtonSegment(value: ThemeMode.light, label: Text(l.themeLight)),
              ],
              selected: {settings.themeMode},
              onSelectionChanged: (s) => context.read<SettingsCubit>().setTheme(s.first),
            ),
            const SizedBox(height: 16),
            Text(l.language, style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 8),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'en', label: Text('English')),
                ButtonSegment(value: 'ur', label: Text('اردو')),
              ],
              selected: {settings.locale.languageCode},
              onSelectionChanged: (s) => context.read<SettingsCubit>().setLocale(Locale(s.first)),
            ),
            const SizedBox(height: 24),
            OutlinedButton.icon(
              key: const Key('sign-out'),
              icon: const Icon(Icons.logout_rounded),
              label: Text(l.signOut),
              onPressed: () => context.read<AuthBloc>().add(const AuthSignOutRequested()),
            ),
          ],
        ),
      ),
    );
  }
}

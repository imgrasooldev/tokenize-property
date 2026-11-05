import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:property_token_app/core/format/money.dart';
import 'package:property_token_app/features/invest/presentation/change_cubit.dart';
import 'package:property_token_app/features/invest/presentation/confirm_on_website.dart';
import 'package:property_token_app/features/portfolio/domain/portfolio.dart';
import 'package:property_token_app/l10n/gen/app_localizations.dart';

/// Phase 2b (ADR 0018 amendment 2): cancel an unpaid reservation or withdraw a
/// paid subscription; the investor confirms on the website.
class ChangePage extends StatelessWidget {
  const ChangePage({required this.subscription, super.key});

  final Subscription subscription;

  /// The API and the website decide again; these only choose what to offer.
  static bool canCancel(String status) => const {'kyc_pending', 'payment_pending', 'waitlisted'}.contains(status);
  static bool canWithdraw(String status) => status == 'payment_confirmed';

  String _error(AppLocalizations l, String code) => switch (code) {
    'not_allowed_now' => l.changeErr_not_allowed_now,
    'too_many_pending' => l.investErr_too_many_pending,
    _ => l.investErr_other,
  };

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final lang = Localizations.localeOf(context).languageCode;
    final sub = subscription;
    final cancel = canCancel(sub.status);
    return Scaffold(
      appBar: AppBar(title: Text(l.changeTitle)),
      body: BlocBuilder<ChangeCubit, ChangeState>(
        builder: (context, s) => ListView(
          padding: const EdgeInsets.all(16),
          children: switch (s) {
            ChangeIdle() || ChangeSubmitting() => [
              Text('${l.units(formatUnits(sub.units, lang))} · ${formatPkr(sub.amountPaisa, lang)}'),
              Text(sub.status, style: Theme.of(context).textTheme.bodySmall),
              const SizedBox(height: 12),
              Text(cancel ? l.changeHowCancel : l.changeHowWithdraw),
              if (s is ChangeIdle && s.error != null) ...[
                const SizedBox(height: 8),
                Text(
                  _error(l, s.error!),
                  key: const Key('change-error'),
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ],
              const SizedBox(height: 16),
              FilledButton(
                key: const Key('change-ask'),
                onPressed: s is ChangeSubmitting
                    ? null
                    : () => unawaited(context.read<ChangeCubit>().ask(cancel ? 'cancel' : 'withdraw')),
                child: Text(cancel ? l.changeCancel : l.changeWithdraw),
              ),
            ],
            ChangeWaiting(:final request) => [ConfirmOnWebsite(request: request)],
            ChangeDone() => [Text(l.changeDone, key: const Key('change-done'))],
            ChangeEnded(:final status) => [Text(l.changeEnded(status), key: const Key('change-ended'))],
          },
        ),
      ),
    );
  }
}

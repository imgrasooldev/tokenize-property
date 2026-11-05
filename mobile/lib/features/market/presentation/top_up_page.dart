import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:property_token_app/features/invest/presentation/confirm_on_website.dart';
import 'package:property_token_app/features/market/presentation/top_up_cubit.dart';
import 'package:property_token_app/l10n/gen/app_localizations.dart';

/// Adding demo cash for buy orders (ADR 0018 amendment 5), confirmed on the website.
class TopUpPage extends StatefulWidget {
  const TopUpPage({super.key});

  @override
  State<TopUpPage> createState() => _TopUpPageState();
}

class _TopUpPageState extends State<TopUpPage> {
  final _amount = TextEditingController(text: '10000');

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(l.topUpTitle)),
      body: BlocBuilder<TopUpCubit, TopUpState>(
        builder: (context, s) => ListView(
          padding: const EdgeInsets.all(16),
          children: switch (s) {
            TopUpEditing() || TopUpSubmitting() => [
              TextField(
                key: const Key('topup-amount'),
                controller: _amount,
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                decoration: InputDecoration(labelText: l.topUpAmount, border: const OutlineInputBorder()),
              ),
              if (s is TopUpEditing && s.error != null) ...[
                const SizedBox(height: 8),
                Text(
                  switch (s.error) {
                    'invalid_amount' => l.topUpInvalid,
                    'too_many_pending' => l.investErr_too_many_pending,
                    _ => l.investErr_other,
                  },
                  key: const Key('topup-error'),
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ],
              const SizedBox(height: 16),
              FilledButton(
                key: const Key('topup-ask'),
                onPressed: s is TopUpSubmitting
                    ? null
                    : () => unawaited(context.read<TopUpCubit>().submit(_amount.text)),
                child: Text(l.topUpAsk),
              ),
              const SizedBox(height: 12),
              Text(l.topUpHow, style: Theme.of(context).textTheme.bodySmall),
            ],
            TopUpWaiting(:final request) => [ConfirmOnWebsite(request: request)],
            TopUpDone() => [Text(l.topUpDone, key: const Key('topup-done'))],
            TopUpEnded(:final status) => [Text(l.topUpEnded(status), key: const Key('topup-ended'))],
          },
        ),
      ),
    );
  }
}

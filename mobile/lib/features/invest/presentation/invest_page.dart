import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:intl/intl.dart';
import 'package:property_token_app/core/format/money.dart';
import 'package:property_token_app/features/invest/presentation/invest_cubit.dart';
import 'package:property_token_app/features/offerings/domain/offering.dart';
import 'package:property_token_app/l10n/gen/app_localizations.dart';

/// Phase 2a (ADR 0018 amendment 1): the investor asks to reserve units here and
/// confirms on the website; the app then shows the Raast payment instructions.
class InvestPage extends StatefulWidget {
  const InvestPage({required this.offering, super.key});

  final Offering offering;

  @override
  State<InvestPage> createState() => _InvestPageState();
}

class _InvestPageState extends State<InvestPage> {
  final _units = TextEditingController(text: '10');

  @override
  void initState() {
    super.initState();
    _units.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _units.dispose();
    super.dispose();
  }

  String _error(AppLocalizations l, String code) => switch (code) {
    'invalid_units' => l.investErr_invalid_units,
    'offering_not_open' => l.investErr_offering_not_open,
    'too_many_pending' => l.investErr_too_many_pending,
    _ => l.investErr_other,
  };

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final lang = Localizations.localeOf(context).languageCode;
    final time = DateFormat.Hm(lang);
    final o = widget.offering;
    return Scaffold(
      appBar: AppBar(title: Text('${l.investTitle} · ${o.title}')),
      body: BlocBuilder<InvestCubit, InvestState>(
        builder: (context, s) => ListView(
          padding: const EdgeInsets.all(16),
          children: switch (s) {
            InvestEditing() || InvestSubmitting() => [
              Text('${l.pricePerUnit}: ${formatPkr(o.pricePaisa, lang)}'),
              const SizedBox(height: 12),
              TextField(
                key: const Key('invest-units'),
                controller: _units,
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                decoration: InputDecoration(labelText: l.investUnits, border: const OutlineInputBorder()),
              ),
              const SizedBox(height: 8),
              if (RegExp(r'^[1-9][0-9]{0,12}$').hasMatch(_units.text))
                Text(
                  l.investYouPay(formatPkr((BigInt.parse(o.pricePaisa) * BigInt.parse(_units.text)).toString(), lang)),
                ),
              if (s is InvestEditing && s.error != null) ...[
                const SizedBox(height: 8),
                Text(
                  _error(l, s.error!),
                  key: const Key('invest-error'),
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ],
              const SizedBox(height: 16),
              FilledButton(
                key: const Key('invest-ask'),
                onPressed: s is InvestSubmitting
                    ? null
                    : () => unawaited(context.read<InvestCubit>().submit(_units.text)),
                child: Text(l.investAsk),
              ),
              const SizedBox(height: 12),
              Text(l.investHow, style: Theme.of(context).textTheme.bodySmall),
            ],
            InvestWaiting(:final request) => [
              Text(l.investWaiting, style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 16),
              Text(l.investCode),
              SelectableText(
                request.code,
                key: const Key('invest-code'),
                style: Theme.of(context).textTheme.headlineMedium,
              ),
              const SizedBox(height: 16),
              Text(l.investOpen),
              SelectableText(request.confirmUriComplete),
              const SizedBox(height: 8),
              OutlinedButton.icon(
                icon: const Icon(Icons.copy),
                label: Text(l.investCopy),
                onPressed: () async {
                  await Clipboard.setData(ClipboardData(text: request.confirmUriComplete));
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(l.investCopied)));
                  }
                },
              ),
              const SizedBox(height: 16),
              Text(l.investConfirmBefore(time.format(request.expiresAt.toLocal()))),
              const SizedBox(height: 16),
              const LinearProgressIndicator(),
            ],
            InvestConfirmed(:final subscription) => [
              Text(
                l.investConfirmed,
                key: const Key('invest-confirmed'),
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 12),
              ListTile(title: Text(l.investAmount), subtitle: Text(formatPkr(subscription.amountPaisa, lang))),
              if (subscription.paymentCode != null)
                ListTile(
                  title: Text(l.investPayCode),
                  subtitle: SelectableText(subscription.paymentCode!, key: const Key('invest-pay-code')),
                ),
              if (subscription.payToAccount != null)
                ListTile(title: Text(l.investPayTo), subtitle: SelectableText(subscription.payToAccount!)),
              if (subscription.payBefore != null)
                ListTile(title: Text(l.investPayBefore(time.format(subscription.payBefore!.toLocal())))),
              const SizedBox(height: 8),
              Text(l.investPayNote, style: Theme.of(context).textTheme.bodySmall),
            ],
            InvestEnded(:final status) => [
              Text(l.investEnded(status), key: const Key('invest-ended')),
              const SizedBox(height: 16),
              FilledButton(onPressed: context.read<InvestCubit>().restart, child: Text(l.investAgain)),
            ],
          },
        ),
      ),
    );
  }
}

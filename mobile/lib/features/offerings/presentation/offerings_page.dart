import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:property_token_app/core/bloc/loader_view.dart';
import 'package:property_token_app/core/format/money.dart';
import 'package:property_token_app/features/offerings/domain/offering.dart';
import 'package:property_token_app/features/offerings/presentation/offerings_bloc.dart';
import 'package:property_token_app/l10n/gen/app_localizations.dart';

class OfferingsPage extends StatelessWidget {
  const OfferingsPage({super.key});

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(l.offeringsTitle)),
      body: LoaderView<OfferingsBloc, List<Offering>>(
        builder: (context, offerings) => offerings.isEmpty
            ? ListView(
                children: [Padding(padding: const EdgeInsets.all(24), child: Text(l.offeringsEmpty))],
              )
            : ListView.separated(
                padding: const EdgeInsets.all(16),
                itemCount: offerings.length + 1,
                separatorBuilder: (_, _) => const SizedBox(height: 12),
                itemBuilder: (context, i) => i == offerings.length
                    ? Text(l.readOnlyNote, style: Theme.of(context).textTheme.bodySmall)
                    : _OfferingCard(offerings[i]),
              ),
      ),
    );
  }
}

class _OfferingCard extends StatelessWidget {
  const _OfferingCard(this.o);

  final Offering o;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final lang = Localizations.localeOf(context).languageCode;
    final scheme = Theme.of(context).colorScheme;
    final cap = BigInt.parse(o.hardCapUnits);
    final sold = cap == BigInt.zero ? 0.0 : 1 - BigInt.parse(o.availableUnits) / cap;
    return Card(
      key: Key('offering-${o.id}'),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(child: Text(o.title, style: Theme.of(context).textTheme.titleMedium)),
                Chip(label: Text(l.stateLabel(o.state)), backgroundColor: scheme.primary.withValues(alpha: 0.15)),
              ],
            ),
            if (o.district != null)
              Text(
                [o.district, o.province].whereType<String>().join(', '),
                style: Theme.of(context).textTheme.bodySmall,
              ),
            const SizedBox(height: 12),
            Text('${l.pricePerUnit}: ${formatPkr(o.pricePaisa, lang)}'),
            const SizedBox(height: 8),
            LinearProgressIndicator(
              value: sold.clamp(0, 1).toDouble(),
              minHeight: 6,
              borderRadius: BorderRadius.circular(6),
            ),
            const SizedBox(height: 4),
            Text(
              l.unitsAvailable(formatUnits(o.availableUnits, lang), formatUnits(o.hardCapUnits, lang)),
              style: Theme.of(context).textTheme.bodySmall,
            ),
            if (o.state == 'live') ...[
              const SizedBox(height: 12),
              Align(
                alignment: AlignmentDirectional.centerEnd,
                child: FilledButton(
                  key: Key('invest-${o.id}'),
                  onPressed: () => unawaited(context.push('/invest', extra: o)),
                  child: Text(l.investButton),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

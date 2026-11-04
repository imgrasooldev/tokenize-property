import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:property_token_app/core/bloc/loader_view.dart';
import 'package:property_token_app/core/format/money.dart';
import 'package:property_token_app/features/rent/domain/rent.dart';
import 'package:property_token_app/features/rent/presentation/rent_bloc.dart';
import 'package:property_token_app/l10n/gen/app_localizations.dart';

/// Rent distributions with gross, withholding tax and net; each opens its Merkle proof.
class RentPage extends StatelessWidget {
  const RentPage({super.key});

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final lang = Localizations.localeOf(context).languageCode;
    return Scaffold(
      appBar: AppBar(title: Text(l.rentTitle)),
      body: LoaderView<RentBloc, List<RentDistribution>>(
        builder: (context, list) => ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (list.isEmpty) Text(l.rentEmpty),
            for (final d in list)
              Card(
                child: ListTile(
                  key: Key('rent-${d.distributionId}'),
                  title: Text('${d.period} · ${formatPkr(d.netPaisa, lang)}'),
                  subtitle: Text(
                    '${l.rentGross} ${formatPkr(d.grossPaisa, lang)} · ${l.rentWithheld} ${formatPkr(d.withheldPaisa, lang)}\n${l.rentStatus(d.status)}',
                  ),
                  isThreeLine: true,
                  trailing: const Icon(Icons.verified_outlined),
                  onTap: () => unawaited(
                    showModalBottomSheet<void>(
                      context: context,
                      builder: (_) => BlocProvider(
                        create: (_) {
                          final cubit = ProofCubit(context.read<RentRepository>());
                          unawaited(cubit.load(d));
                          return cubit;
                        },
                        child: const _ProofSheet(),
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _ProofSheet extends StatelessWidget {
  const _ProofSheet();

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final lang = Localizations.localeOf(context).languageCode;
    return Padding(
      padding: const EdgeInsets.all(20),
      child: BlocBuilder<ProofCubit, ProofState>(
        builder: (context, s) {
          final p = s.proof;
          if (s.failed) return Text(l.errorGeneric);
          if (p == null) return const SizedBox(height: 120, child: Center(child: CircularProgressIndicator()));
          final ok = p.statementMatches;
          return Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(
                    ok ? Icons.verified_rounded : Icons.error_outline,
                    color: ok ? Colors.green : Theme.of(context).colorScheme.error,
                  ),
                  const SizedBox(width: 8),
                  Expanded(child: Text(ok ? l.proofOk : l.proofMismatch, key: const Key('proof-result'))),
                ],
              ),
              const SizedBox(height: 12),
              Text('${l.rentNet}: ${formatPkr(p.netPaisa, lang)}'),
              const SizedBox(height: 8),
              Text(l.proofSteps(p.proof.length.toString())),
              const SizedBox(height: 8),
              SelectableText(
                'root ${p.merkleRoot}',
                textDirection: TextDirection.ltr,
                style: Theme.of(context).textTheme.bodySmall,
              ),
              SelectableText(
                'leaf ${p.leaf}',
                textDirection: TextDirection.ltr,
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: 8),
              Text(l.proofHow, style: Theme.of(context).textTheme.bodySmall),
            ],
          );
        },
      ),
    );
  }
}

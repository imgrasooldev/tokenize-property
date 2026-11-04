import 'package:flutter/material.dart';
import 'package:property_token_app/core/bloc/loader_view.dart';
import 'package:property_token_app/core/format/money.dart';
import 'package:property_token_app/features/portfolio/domain/portfolio.dart';
import 'package:property_token_app/features/portfolio/presentation/portfolio_bloc.dart';
import 'package:property_token_app/l10n/gen/app_localizations.dart';

class PortfolioPage extends StatelessWidget {
  const PortfolioPage({super.key});

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final lang = Localizations.localeOf(context).languageCode;
    return Scaffold(
      appBar: AppBar(title: Text(l.portfolioTitle)),
      body: LoaderView<PortfolioBloc, Portfolio>(
        builder: (context, p) => ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text(l.holdings, style: Theme.of(context).textTheme.titleMedium),
            if (p.holdings.isEmpty)
              Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text(l.noHoldings)),
            for (final h in p.holdings)
              Card(
                child: ListTile(
                  key: Key('holding-${h.token}'),
                  title: Text(l.units(formatUnits(h.units, lang))),
                  subtitle: Text(h.token, textDirection: TextDirection.ltr, overflow: TextOverflow.ellipsis),
                  trailing: h.frozenUnits == '0' ? null : Text(l.frozenUnits(formatUnits(h.frozenUnits, lang))),
                ),
              ),
            const SizedBox(height: 16),
            Text(l.subscriptions, style: Theme.of(context).textTheme.titleMedium),
            if (p.subscriptions.isEmpty)
              Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text(l.noSubscriptions)),
            for (final s in p.subscriptions)
              Card(
                child: ListTile(
                  title: Text('${l.units(formatUnits(s.units, lang))} · ${formatPkr(s.amountPaisa, lang)}'),
                  subtitle: Text(s.status),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

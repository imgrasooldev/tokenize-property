import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:property_token_app/core/bloc/loader_view.dart';
import 'package:property_token_app/core/format/money.dart';
import 'package:property_token_app/features/market/domain/market.dart';
import 'package:property_token_app/features/market/presentation/market_bloc.dart';
import 'package:property_token_app/l10n/gen/app_localizations.dart';

/// The demo market (ADR 0018 amendment 3): order books, the investor's orders,
/// and "Place an order", which the investor then confirms on the website.
class MarketPage extends StatelessWidget {
  const MarketPage({super.key});

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final lang = Localizations.localeOf(context).languageCode;
    return Scaffold(
      appBar: AppBar(title: Text(l.marketTitle)),
      body: LoaderView<MarketBloc, MarketData>(
        builder: (context, d) => ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (d.cash case final cash?)
              Card(
                child: ListTile(
                  key: const Key('market-cash'),
                  title: Text(l.cashTitle),
                  subtitle: Text(l.cashLine(formatPkr(cash.availablePaisa, lang), formatPkr(cash.inOrdersPaisa, lang))),
                  trailing: TextButton(
                    key: const Key('cash-add'),
                    onPressed: () => unawaited(context.push('/market/topup')),
                    child: Text(l.cashAdd),
                  ),
                ),
              ),
            if (d.markets.isEmpty) Text(l.marketNone),
            for (final m in d.markets) _BookCard(m),
            const SizedBox(height: 16),
            Text(l.marketMyOrders, style: Theme.of(context).textTheme.titleMedium),
            if (d.orders.isEmpty)
              Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text(l.marketNoOrders)),
            for (final o in d.orders)
              Card(
                child: ListTile(
                  key: Key('order-${o.id}'),
                  title: Text(
                    '${o.side == 'buy' ? l.orderBuy : l.orderSell} ${formatUnits(o.tokens, lang)} ${o.symbol} · ${formatPkr(o.pricePaisa, lang)}',
                  ),
                  subtitle: Text(
                    '${o.status} · ${l.marketFilled(formatUnits(o.filled, lang), formatUnits(o.tokens, lang))}',
                  ),
                  trailing: o.status == 'open'
                      ? TextButton(
                          key: Key('order-cancel-${o.id}'),
                          onPressed: () => unawaited(context.push('/market/cancel', extra: o)),
                          child: Text(l.orderCancelButton),
                        )
                      : null,
                ),
              ),
            const SizedBox(height: 12),
            Text(l.marketNote, style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
      ),
    );
  }
}

class _BookCard extends StatelessWidget {
  const _BookCard(this.m);

  final MarketBook m;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final lang = Localizations.localeOf(context).languageCode;
    Widget side(String title, List<BookLevel> levels) => Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: Theme.of(context).textTheme.labelLarge),
          if (levels.isEmpty) Text('—', style: Theme.of(context).textTheme.bodySmall),
          for (final v in levels.take(5))
            Text(
              '${formatPkr(v.pricePaisa, lang)} · ${formatUnits(v.tokens, lang)}',
              style: Theme.of(context).textTheme.bodySmall,
            ),
        ],
      ),
    );
    return Card(
      key: Key('market-${m.symbol}'),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(child: Text(m.symbol, style: Theme.of(context).textTheme.titleMedium)),
                if (m.lastPricePaisa != null) Text('${l.marketLast}: ${formatPkr(m.lastPricePaisa!, lang)}'),
              ],
            ),
            const SizedBox(height: 8),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [side(l.marketBids, m.bids), const SizedBox(width: 12), side(l.marketAsks, m.asks)],
            ),
            const SizedBox(height: 12),
            Align(
              alignment: AlignmentDirectional.centerEnd,
              child: FilledButton(
                key: Key('order-open-${m.symbol}'),
                onPressed: () => unawaited(context.push('/market/order', extra: m)),
                child: Text(l.marketOrderButton),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

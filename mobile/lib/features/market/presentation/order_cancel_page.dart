import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:property_token_app/core/format/money.dart';
import 'package:property_token_app/features/invest/presentation/confirm_on_website.dart';
import 'package:property_token_app/features/market/domain/market.dart';
import 'package:property_token_app/features/market/presentation/order_cubit.dart';
import 'package:property_token_app/l10n/gen/app_localizations.dart';

/// Cancelling one of the investor's open orders (ADR 0018 amendment 4),
/// confirmed on the website like every other money move from the app.
class OrderCancelPage extends StatelessWidget {
  const OrderCancelPage({required this.order, super.key});

  final MarketOrder order;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final lang = Localizations.localeOf(context).languageCode;
    return Scaffold(
      appBar: AppBar(title: Text(l.orderCancelTitle)),
      body: BlocBuilder<OrderCubit, OrderState>(
        builder: (context, s) => ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Card(
              child: ListTile(
                title: Text(
                  '${order.side == 'buy' ? l.orderBuy : l.orderSell} ${formatUnits(order.tokens, lang)} ${order.symbol} · ${formatPkr(order.pricePaisa, lang)}',
                ),
                subtitle: Text(l.marketFilled(formatUnits(order.filled, lang), formatUnits(order.tokens, lang))),
              ),
            ),
            const SizedBox(height: 16),
            ...switch (s) {
              OrderEditing() || OrderSubmitting() => [
                if (s is OrderEditing && s.error != null) ...[
                  Text(
                    switch (s.error) {
                      'not_found' => l.orderCancelNotOpen,
                      'too_many_pending' => l.investErr_too_many_pending,
                      _ => l.investErr_other,
                    },
                    key: const Key('order-cancel-error'),
                    style: TextStyle(color: Theme.of(context).colorScheme.error),
                  ),
                  const SizedBox(height: 8),
                ],
                FilledButton(
                  key: const Key('order-cancel-ask'),
                  onPressed: s is OrderSubmitting
                      ? null
                      : () => unawaited(context.read<OrderCubit>().cancelOrder(order.id)),
                  child: Text(l.orderCancelAsk),
                ),
                const SizedBox(height: 12),
                Text(l.orderCancelHow, style: Theme.of(context).textTheme.bodySmall),
              ],
              OrderWaiting(:final request) => [ConfirmOnWebsite(request: request)],
              OrderPlaced() => [Text(l.orderCancelDone, key: const Key('order-cancel-done'))],
              OrderEnded(:final status) => [Text(l.orderCancelEnded(status), key: const Key('order-cancel-ended'))],
            },
          ],
        ),
      ),
    );
  }
}

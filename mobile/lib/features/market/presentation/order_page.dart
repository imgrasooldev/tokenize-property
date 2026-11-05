import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:property_token_app/core/format/money.dart';
import 'package:property_token_app/features/invest/presentation/confirm_on_website.dart';
import 'package:property_token_app/features/market/domain/market.dart';
import 'package:property_token_app/features/market/presentation/order_cubit.dart';
import 'package:property_token_app/l10n/gen/app_localizations.dart';

/// A limit order on the demo market (ADR 0018 amendment 3), confirmed on the website.
class OrderPage extends StatefulWidget {
  const OrderPage({required this.market, super.key});

  final MarketBook market;

  @override
  State<OrderPage> createState() => _OrderPageState();
}

class _OrderPageState extends State<OrderPage> {
  var _side = 'buy';
  late final _price = TextEditingController(
    text: widget.market.lastPricePaisa == null
        ? ''
        : (BigInt.parse(widget.market.lastPricePaisa!) ~/ BigInt.from(100)).toString(),
  );
  final _tokens = TextEditingController(text: '10');

  @override
  void initState() {
    super.initState();
    _price.addListener(() => setState(() {}));
    _tokens.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _price.dispose();
    _tokens.dispose();
    super.dispose();
  }

  String _error(AppLocalizations l, String code) => switch (code) {
    'invalid_order' => l.orderErr_invalid,
    'too_many_pending' => l.investErr_too_many_pending,
    _ => l.investErr_other,
  };

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final lang = Localizations.localeOf(context).languageCode;
    final paisa = rupeesToPaisa(_price.text);
    final tokensOk = RegExp(r'^[1-9][0-9]{0,5}$').hasMatch(_tokens.text.trim());
    return Scaffold(
      appBar: AppBar(title: Text('${l.orderTitle} · ${widget.market.symbol}')),
      body: BlocBuilder<OrderCubit, OrderState>(
        builder: (context, s) => ListView(
          padding: const EdgeInsets.all(16),
          children: switch (s) {
            OrderEditing() || OrderSubmitting() => [
              SegmentedButton<String>(
                key: const Key('order-side'),
                segments: [
                  ButtonSegment(value: 'buy', label: Text(l.orderBuy)),
                  ButtonSegment(value: 'sell', label: Text(l.orderSell)),
                ],
                selected: {_side},
                onSelectionChanged: (v) => setState(() => _side = v.first),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const Key('order-price'),
                controller: _price,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                inputFormatters: [FilteringTextInputFormatter.allow(RegExp('[0-9.]'))],
                decoration: InputDecoration(labelText: l.orderPrice, border: const OutlineInputBorder()),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const Key('order-tokens'),
                controller: _tokens,
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                decoration: InputDecoration(labelText: l.orderTokens, border: const OutlineInputBorder()),
              ),
              const SizedBox(height: 8),
              if (paisa != null && tokensOk)
                Text(
                  l.orderTotal(formatPkr((BigInt.parse(paisa) * BigInt.parse(_tokens.text.trim())).toString(), lang)),
                ),
              if (s is OrderEditing && s.error != null) ...[
                const SizedBox(height: 8),
                Text(
                  _error(l, s.error!),
                  key: const Key('order-error'),
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ],
              const SizedBox(height: 16),
              FilledButton(
                key: const Key('order-ask'),
                onPressed: s is OrderSubmitting
                    ? null
                    : () => unawaited(
                        context.read<OrderCubit>().submit(side: _side, price: _price.text, tokens: _tokens.text),
                      ),
                child: Text(l.orderAsk),
              ),
              const SizedBox(height: 12),
              Text(l.orderHow, style: Theme.of(context).textTheme.bodySmall),
            ],
            OrderWaiting(:final request) => [ConfirmOnWebsite(request: request)],
            OrderPlaced() => [Text(l.orderPlaced, key: const Key('order-placed'))],
            OrderEnded(:final status) => [
              Text(l.orderEnded(status), key: const Key('order-ended')),
              const SizedBox(height: 16),
              FilledButton(onPressed: context.read<OrderCubit>().restart, child: Text(l.investAgain)),
            ],
          },
        ),
      ),
    );
  }
}

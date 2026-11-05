import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/features/market/domain/market.dart';
import 'package:property_token_app/features/market/presentation/order_cubit.dart';

class _MockMarket extends Mock implements MarketRepository {}

OrderRequest _r(String status, {String? order}) => OrderRequest(
  id: 'q-1',
  symbol: 'GPF3',
  side: 'buy',
  pricePaisa: '50050',
  tokens: '10',
  totalPaisa: '500500',
  status: status,
  code: 'BCDF-GHJK',
  confirmUriComplete: 'http://site/confirm?code=BCDF-GHJK',
  expiresAt: DateTime.utc(2026, 11, 5, 12),
  orderId: order,
);

void main() {
  test('rupees become paisa without floats; anything else is refused', () {
    expect(rupeesToPaisa('500'), '50000');
    expect(rupeesToPaisa('500.5'), '50050');
    expect(rupeesToPaisa(' 500.25 '), '50025');
    expect(rupeesToPaisa('0.5'), isNull);
    expect(rupeesToPaisa('500.255'), isNull);
    expect(rupeesToPaisa('5e2'), isNull);
  });

  blocTest<OrderCubit, OrderState>(
    'asks with the price in paisa, waits for the website, then shows it placed',
    build: () {
      final repo = _MockMarket();
      when(
        () => repo.requestOrder(
          symbol: 'GPF3',
          side: 'buy',
          pricePaisa: '50050',
          tokens: '10',
          idempotencyKey: any(named: 'idempotencyKey'),
        ),
      ).thenAnswer((_) async => _r('pending'));
      when(() => repo.orderRequest('q-1')).thenAnswer((_) async => _r('confirmed', order: 'o-9'));
      return OrderCubit(repo, symbol: 'GPF3', pollEvery: null);
    },
    act: (c) async {
      await c.submit(side: 'buy', price: '500.5', tokens: '10');
      await c.refresh();
    },
    expect: () => [const OrderSubmitting(), OrderWaiting(_r('pending')), OrderPlaced(_r('confirmed', order: 'o-9'))],
  );

  blocTest<OrderCubit, OrderState>(
    'a bad price never reaches the API; a refusal shows its code; a declined request ends',
    build: () {
      final repo = _MockMarket();
      var calls = 0;
      when(
        () => repo.requestOrder(
          symbol: 'GPF3',
          side: 'sell',
          pricePaisa: '50000',
          tokens: '10',
          idempotencyKey: any(named: 'idempotencyKey'),
        ),
      ).thenAnswer((_) async {
        calls++;
        if (calls == 1) throw const ApiException(409, 'too_many_pending');
        return _r('declined');
      });
      return OrderCubit(repo, symbol: 'GPF3', pollEvery: null);
    },
    act: (c) async {
      await c.submit(side: 'sell', price: 'abc', tokens: '10');
      await c.submit(side: 'sell', price: '500', tokens: '10');
      await c.submit(side: 'sell', price: '500', tokens: '10');
    },
    expect: () => [
      const OrderEditing(error: 'invalid_order'),
      const OrderSubmitting(),
      const OrderEditing(error: 'too_many_pending'),
      const OrderSubmitting(),
      const OrderEnded('declined'),
    ],
  );

  test('parses a market book and an order request from the contract', () {
    final b = MarketBook.fromJson(const {
      'symbol': 'GPF3',
      'bids': [
        {
          'price': {'amount': '50000', 'currency': 'PKR'},
          'tokens': '3',
        },
      ],
      'asks': <Object>[],
      'last_price': null,
      'last_trade_at': null,
    });
    expect(b.bids.single.pricePaisa, '50000');
    expect(b.lastPricePaisa, isNull);
    final r = OrderRequest.fromJson(const {
      'id': 'q-2',
      'symbol': 'GPF3',
      'side': 'sell',
      'price': {'amount': '50000', 'currency': 'PKR'},
      'tokens': '10',
      'total': {'amount': '500000', 'currency': 'PKR'},
      'status': 'pending',
      'confirmation_code': 'BCDF-GHJK',
      'confirmation_uri': 'http://site/confirm',
      'confirmation_uri_complete': 'http://site/confirm?code=BCDF-GHJK',
      'created_at': '2026-11-05T12:00:00Z',
      'expires_at': '2026-11-05T12:15:00Z',
      'order_id': null,
    });
    expect(r.totalPaisa, '500000');
    expect(r.pending, isTrue);
  });
}

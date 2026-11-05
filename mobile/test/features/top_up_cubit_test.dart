import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/features/market/domain/market.dart';
import 'package:property_token_app/features/market/presentation/top_up_cubit.dart';

class _MockMarket extends Mock implements MarketRepository {}

TopUpRequest _r(String status, {String? topUp}) => TopUpRequest(
  id: 't-1',
  amountPaisa: '1000000',
  status: status,
  code: 'BCDF-GHJK',
  confirmUriComplete: 'http://site/confirm?code=BCDF-GHJK',
  expiresAt: DateTime.utc(2026, 11, 5, 12),
  topUpId: topUp,
);

void main() {
  blocTest<TopUpCubit, TopUpState>(
    'asks with whole rupees in paisa, waits for the website, then shows it added',
    build: () {
      final repo = _MockMarket();
      when(
        () => repo.requestTopUp(
          amountPaisa: '1000000',
          idempotencyKey: any(named: 'idempotencyKey'),
        ),
      ).thenAnswer((_) async => _r('pending'));
      when(() => repo.topUpRequest('t-1')).thenAnswer((_) async => _r('confirmed', topUp: 'u-1'));
      return TopUpCubit(repo, pollEvery: null);
    },
    act: (c) async {
      await c.submit(' 10000 ');
      await c.refresh();
    },
    expect: () => [const TopUpSubmitting(), TopUpWaiting(_r('pending')), TopUpDone(_r('confirmed', topUp: 'u-1'))],
  );

  blocTest<TopUpCubit, TopUpState>(
    'a bad amount never reaches the API; a refusal shows its code; a declined request ends',
    build: () {
      final repo = _MockMarket();
      var calls = 0;
      when(
        () => repo.requestTopUp(
          amountPaisa: any(named: 'amountPaisa'),
          idempotencyKey: any(named: 'idempotencyKey'),
        ),
      ).thenAnswer((_) async {
        calls++;
        if (calls == 1) throw const ApiException(409, 'too_many_pending');
        return _r('pending');
      });
      when(() => repo.topUpRequest('t-1')).thenAnswer((_) async => _r('declined'));
      return TopUpCubit(repo, pollEvery: null);
    },
    act: (c) async {
      await c.submit('0');
      await c.submit('10.5');
      await c.submit('10000001');
      await c.submit('500');
      await c.submit('500');
      await c.refresh();
    },
    expect: () => [
      const TopUpEditing(error: 'invalid_amount'),
      const TopUpSubmitting(),
      const TopUpEditing(error: 'too_many_pending'),
      const TopUpSubmitting(),
      TopUpWaiting(_r('pending')),
      const TopUpEnded('declined'),
    ],
  );
}

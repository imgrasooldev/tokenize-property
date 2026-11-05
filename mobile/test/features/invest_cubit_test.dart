import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/features/invest/domain/invest.dart';
import 'package:property_token_app/features/invest/presentation/invest_cubit.dart';

class _MockInvest extends Mock implements InvestRepository {}

SubscriptionRequest _r(String status, {String? sub}) => SubscriptionRequest(
  id: 'r-1',
  offeringId: 'o-1',
  units: '10',
  amountPaisa: '1000000',
  status: status,
  code: 'BCDF-GHJK',
  confirmUri: 'http://site/confirm',
  confirmUriComplete: 'http://site/confirm?code=BCDF-GHJK',
  expiresAt: DateTime.utc(2026, 11, 5, 12),
  subscriptionId: sub,
);

const _detail = SubscriptionDetail(
  id: 's-1',
  units: '10',
  amountPaisa: '1000000',
  status: 'payment_pending',
  paymentCode: 'PT-ABCD-EFGH',
  payToAccount: 'TRUSTEE-ESCROW-01',
  payBefore: null,
);

void main() {
  blocTest<InvestCubit, InvestState>(
    'asks, waits for the website, then shows the payment instructions',
    build: () {
      final repo = _MockInvest();
      when(
        () => repo.requestReservation(
          offeringId: 'o-1',
          units: '10',
          idempotencyKey: any(named: 'idempotencyKey'),
        ),
      ).thenAnswer((_) async => _r('pending'));
      when(() => repo.request('r-1')).thenAnswer((_) async => _r('confirmed', sub: 's-1'));
      when(() => repo.subscription('s-1')).thenAnswer((_) async => _detail);
      return InvestCubit(repo, offeringId: 'o-1', pollEvery: null);
    },
    act: (c) async {
      await c.submit('10');
      await c.refresh();
    },
    expect: () => [
      const InvestSubmitting(),
      InvestWaiting(_r('pending')),
      InvestConfirmed(_r('confirmed', sub: 's-1'), _detail),
    ],
  );

  blocTest<InvestCubit, InvestState>(
    'a retried tap reuses the Idempotency-Key until a request exists; then a new key',
    build: () {
      final repo = _MockInvest();
      final keys = <String>[];
      when(
        () => repo.requestReservation(
          offeringId: 'o-1',
          units: '10',
          idempotencyKey: any(named: 'idempotencyKey'),
        ),
      ).thenAnswer((i) async {
        keys.add(i.namedArguments[#idempotencyKey] as String);
        if (keys.length == 1) throw const ApiException(0, 'unreachable');
        return _r('declined');
      });
      addTearDown(() {
        expect(keys, hasLength(3));
        expect(keys[0], keys[1]);
        expect(keys[2], isNot(keys[1]));
        expect(keys[0], matches(RegExp(r'^app-[0-9a-f]{16}$')));
      });
      return InvestCubit(repo, offeringId: 'o-1', pollEvery: null);
    },
    act: (c) async {
      await c.submit('10');
      await c.submit('10');
      c.restart();
      await c.submit('10');
    },
    expect: () => [
      const InvestSubmitting(),
      const InvestEditing(error: 'unreachable'),
      const InvestSubmitting(),
      const InvestEnded('declined'),
      const InvestEditing(),
      const InvestSubmitting(),
      const InvestEnded('declined'),
    ],
  );

  blocTest<InvestCubit, InvestState>(
    'bad units never reach the API; a refusal is shown by its code',
    build: () {
      final repo = _MockInvest();
      when(
        () => repo.requestReservation(
          offeringId: 'o-1',
          units: '5',
          idempotencyKey: any(named: 'idempotencyKey'),
        ),
      ).thenThrow(const ApiException(422, 'offering_not_open'));
      return InvestCubit(repo, offeringId: 'o-1', pollEvery: null);
    },
    act: (c) async {
      await c.submit('0');
      await c.submit('5');
    },
    expect: () => [
      const InvestEditing(error: 'invalid_units'),
      const InvestSubmitting(),
      const InvestEditing(error: 'offering_not_open'),
    ],
  );
}

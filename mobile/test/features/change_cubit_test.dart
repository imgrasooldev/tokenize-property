import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/features/invest/domain/invest.dart';
import 'package:property_token_app/features/invest/presentation/change_cubit.dart';

class _MockInvest extends Mock implements InvestRepository {}

SubscriptionRequest _r(String status) => SubscriptionRequest(
  id: 'r-2',
  kind: 'cancel',
  offeringId: 'o-1',
  units: '10',
  amountPaisa: '1000000',
  status: status,
  code: 'CDFG-HJKL',
  confirmUri: 'http://site/confirm',
  confirmUriComplete: 'http://site/confirm?code=CDFG-HJKL',
  expiresAt: DateTime.utc(2026, 11, 5, 12),
  subscriptionId: 's-1',
);

void main() {
  blocTest<ChangeCubit, ChangeState>(
    'asks to cancel, waits for the website, then shows it done',
    build: () {
      final repo = _MockInvest();
      when(
        () => repo.requestChange(
          subscriptionId: 's-1',
          action: 'cancel',
          idempotencyKey: any(named: 'idempotencyKey'),
        ),
      ).thenAnswer((_) async => _r('pending'));
      when(() => repo.request('r-2')).thenAnswer((_) async => _r('confirmed'));
      return ChangeCubit(repo, subscriptionId: 's-1', pollEvery: null);
    },
    act: (c) async {
      await c.ask('cancel');
      await c.refresh();
    },
    expect: () => [const ChangeSubmitting(), ChangeWaiting(_r('pending')), ChangeDone(_r('confirmed'))],
  );

  blocTest<ChangeCubit, ChangeState>(
    'a refusal shows its code; a declined request ends without a change',
    build: () {
      final repo = _MockInvest();
      var calls = 0;
      when(
        () => repo.requestChange(
          subscriptionId: 's-1',
          action: 'withdraw',
          idempotencyKey: any(named: 'idempotencyKey'),
        ),
      ).thenAnswer((_) async {
        calls++;
        if (calls == 1) throw const ApiException(422, 'not_allowed_now');
        return _r('declined');
      });
      return ChangeCubit(repo, subscriptionId: 's-1', pollEvery: null);
    },
    act: (c) async {
      await c.ask('withdraw');
      await c.ask('withdraw');
    },
    expect: () => [
      const ChangeSubmitting(),
      const ChangeIdle(error: 'not_allowed_now'),
      const ChangeSubmitting(),
      const ChangeEnded('declined'),
    ],
  );

  test('parses the kind of a request from the contract', () {
    final r = SubscriptionRequest.fromJson(const {
      'id': 'r-3',
      'kind': 'withdraw',
      'offering_id': 'o-1',
      'units': '10',
      'amount': {'amount': '1000000', 'currency': 'PKR'},
      'status': 'pending',
      'confirmation_code': 'CDFG-HJKL',
      'confirmation_uri': 'http://site/confirm',
      'confirmation_uri_complete': 'http://site/confirm?code=CDFG-HJKL',
      'created_at': '2026-11-05T12:00:00Z',
      'expires_at': '2026-11-05T12:15:00Z',
      'subscription_id': 's-1',
    });
    expect(r.kind, 'withdraw');
    expect(r.subscriptionId, 's-1');
  });
}

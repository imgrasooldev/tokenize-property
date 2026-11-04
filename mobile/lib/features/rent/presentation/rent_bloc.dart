import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:property_token_app/core/bloc/loader_bloc.dart';
import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/features/rent/domain/rent.dart';

class RentBloc extends LoaderBloc<List<RentDistribution>> {
  RentBloc(RentRepository repo) : super(repo.distributions);
}

class ProofState extends Equatable {
  const ProofState({this.loading = false, this.proof, this.failed = false});

  final bool loading;
  final RentProof? proof;
  final bool failed;

  @override
  List<Object?> get props => [loading, proof, failed];
}

/// The proof of one distribution, fetched when the investor opens it.
class ProofCubit extends Cubit<ProofState> {
  ProofCubit(this._repo) : super(const ProofState());

  final RentRepository _repo;

  Future<void> load(RentDistribution d) async {
    emit(const ProofState(loading: true));
    try {
      emit(ProofState(proof: await _repo.proof(d)));
    } on ApiException {
      emit(const ProofState(failed: true));
    }
  }
}

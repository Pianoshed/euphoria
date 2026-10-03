from rest_framework.exceptions import APIException
from rest_framework import status


class DomainError(APIException):
    """Base class for expected business-rule failures.

    Raising this (rather than a bare Exception) guarantees the client
    gets a clean, safe error message instead of a stack trace, while
    the real exception is still logged server-side by DRF's handler.
    """

    status_code = status.HTTP_400_BAD_REQUEST
    default_detail = "The request could not be completed."
    default_code = "domain_error"


class InsufficientBalanceError(DomainError):
    default_detail = "Insufficient balance for this operation."
    default_code = "insufficient_balance"


class InvalidStateTransitionError(DomainError):
    default_detail = "This action is not valid for the current state."
    default_code = "invalid_state_transition"


class DuplicateRequestError(DomainError):
    status_code = status.HTTP_409_CONFLICT
    default_detail = "This request has already been processed."
    default_code = "duplicate_request"


class AccountNotEligibleError(DomainError):
    status_code = status.HTTP_403_FORBIDDEN
    default_detail = "This account is not eligible for this action."
    default_code = "account_not_eligible"
